import {
  BehaviorRegistry,
  BehaviorRuntime,
  type BehaviorEvent,
  type CanvasDefinition,
  type CanvasSnapshot,
  type EffectEmission,
  type Entity,
  type ItemDefinition,
  type ItemInstance,
  type SnapshotItem,
  type SnapshotAvatar,
} from "@canvas-physics/core";
import type { AvatarSpawn } from "./rapier-world.js";
import { RapierWorld } from "./rapier-world.js";

export interface HostStepResult {
  tick: number;
  effects: EffectEmission[];
  behaviorErrors: number;
}

/**
 * The canonical simulation. It owns the physics world and the behavior runtime,
 * and it produces snapshots and deltas. It knows nothing about rendering or
 * transport (spec 8.1).
 */
export class HostSimulation {
  readonly world: RapierWorld;
  readonly behaviors: BehaviorRuntime;
  private checkpointRevision = 0;
  private lastSentTransforms = new Map<string, string>();
  private resolvedConfigByEntityID = new Map<string, unknown>();

  constructor(
    readonly canvas: CanvasDefinition,
    readonly definitions: ItemDefinition[],
    registry: BehaviorRegistry,
    readonly tickRate = 60,
  ) {
    this.world = new RapierWorld(canvas, definitions, tickRate);
    this.behaviors = new BehaviorRuntime(
      registry,
      this.world,
      {
        id: canvas.id,
        width: canvas.size.width,
        height: canvas.size.height,
        orientation: canvas.orientation,
      },
      tickRate,
    );
  }

  get tick(): number {
    return this.world.currentTick;
  }

  /** Spec 13.4. Rebuilds the world from a durable snapshot with zero motion. */
  loadSnapshot(snapshot: CanvasSnapshot, wakeFromSleep = true): void {
    this.checkpointRevision = Math.max(
      this.checkpointRevision,
      snapshot.checkpointRevision,
    );
    this.world.resumeAtTick(snapshot.tick);
    for (const item of snapshot.items) {
      this.addItem(this.instanceFromSnapshot(snapshot.canvasId, item, snapshot.sceneRevision));
      if (item.visualVariant) {
        this.world.setSpriteVariant(item.entityId, item.visualVariant);
      }
      if (item.visualTint !== undefined) {
        this.world.setSpriteTint(item.entityId, item.visualTint);
      }
      if (!wakeFromSleep && item.behaviorTimers?.length) {
        this.behaviors.timers.restore(
          item.entityId,
          item.behaviorTimers,
          snapshot.tick,
        );
      }
    }
    // A sleeping room resets transient workflows. An active host migration
    // resumes the checkpointed state without masquerading as a room wake.
    if (wakeFromSleep) {
      for (const slot of this.behaviors.all()) {
        this.behaviors.emit({
          type: "room.wake",
          tick: this.world.currentTick,
          self: slot.entityId,
          fromSnapshot: true,
        });
      }
    }
  }

  private instanceFromSnapshot(
    canvasId: string,
    item: SnapshotItem,
    sceneRevision: number,
  ): ItemInstance {
    return {
      entityId: item.entityId,
      canvasId,
      definitionId: item.definitionId,
      definitionVersion: item.definitionVersion,
      ownerUserId: item.ownerUserId,
      transform: { ...item.transform },
      resolvedConfig: item.resolvedConfig,
      isolated: item.isolated,
      collisionsDisabled: item.collisionsDisabled,
      behaviorState: item.behaviorState,
      behaviorStateVersion: item.behaviorStateVersion,
      createdAt: new Date().toISOString(),
      sceneRevision,
    };
  }

  addItem(instance: ItemInstance): Entity | undefined {
    const entity = this.world.addItem(instance);
    if (entity) this.resolvedConfigByEntityID.set(entity.id, instance.resolvedConfig);
    if (!entity?.behavior) return entity;
    const slot = this.behaviors.attach({
      entityId: entity.id,
      behaviorType: entity.behavior.behaviorType,
      config: entity.behavior.config,
      state: entity.behavior.state,
      stateVersion: entity.behavior.stateVersion,
      persistent: entity.behavior.persistent,
    });
    if (instance.isolated) {
      this.behaviors.setDisabled(entity.id, true, this.world.currentTick);
    }
    entity.behavior.state = slot.state;
    entity.behavior.stateVersion = slot.stateVersion;
    return entity;
  }

  removeItem(entityId: string): void {
    this.behaviors.detach(entityId);
    this.world.removeEntity(entityId);
    this.lastSentTransforms.delete(entityId);
    this.resolvedConfigByEntityID.delete(entityId);
  }

  setItemConfig(entityId: string, config: unknown): boolean {
    const entity = this.world.registry.get(entityId);
    if (!entity?.behavior || !this.behaviors.setConfig(entityId, config)) return false;
    entity.behavior.config = config;
    return true;
  }

  setItemIsolation(entityId: string, isolated: boolean): boolean {
    if (!this.world.setItemIsolation(entityId, isolated)) return false;
    this.behaviors.setDisabled(entityId, isolated, this.world.currentTick);
    return true;
  }

  setItemCollisionsEnabled(entityId: string, enabled: boolean): boolean {
    return this.world.setItemCollisionsEnabled(entityId, enabled);
  }

  addAvatar(spawn: AvatarSpawn): Entity {
    return this.world.addAvatar(spawn);
  }

  removeAvatar(entityId: string): void {
    this.world.removeEntity(entityId);
    this.lastSentTransforms.delete(entityId);
  }

  step(): HostStepResult {
    const { tick, events } = this.world.step();
    this.behaviors.emitAll(events);
    // Behaviors that need continuous logic receive one tick event.
    for (const slot of this.behaviors.all()) {
      if (slot.disabled) continue;
      this.behaviors.emit({
        type: "tick",
        tick,
        self: slot.entityId,
        dt: 1 / this.tickRate,
      });
    }
    const report = this.behaviors.step(tick);
    return {
      tick,
      effects: this.world.drainEffects(),
      behaviorErrors: report.errors.length,
    };
  }

  /** Queue an external event, such as an owner action. */
  emit(event: BehaviorEvent): void {
    this.behaviors.emit(event);
  }

  /** Spec 13.1. A durable checkpoint with no velocity and no transient state. */
  snapshot(
    normalized = false,
    metadata: { sceneRevision?: number; hostEpoch?: number } = {},
  ): CanvasSnapshot {
    const items: SnapshotItem[] = [];
    const avatars: SnapshotAvatar[] = [];
    for (const entity of this.world.registry.ofKind("item")) {
      const persistence = entity.persistence;
      if (persistence && !persistence.transform) continue;
      const slot = this.behaviors.slot(entity.id);
      const item: SnapshotItem = {
        entityId: entity.id,
        definitionId: entity.render?.definitionId ?? "",
        definitionVersion: entity.render?.definitionVersion ?? 0,
        ownerUserId: entity.ownership?.ownerUserId ?? "",
        transform: { ...entity.transform },
        isolated: entity.isolated || undefined,
        collisionsDisabled: entity.collisionsDisabled || undefined,
        resolvedConfig:
          entity.behavior?.config ?? this.resolvedConfigByEntityID.get(entity.id),
      };
      if (slot && persistence?.behaviorState) {
        item.behaviorState = slot.state;
        item.behaviorStateVersion = slot.stateVersion;
        if (!normalized) {
          const timers = this.behaviors.timers.snapshot(
            entity.id,
            this.world.currentTick,
          );
          if (timers.length > 0) item.behaviorTimers = timers;
        }
      }
      if (entity.render?.variant) item.visualVariant = entity.render.variant;
      if (entity.render?.tint !== undefined) item.visualTint = entity.render.tint;
      items.push(item);
    }
    for (const entity of this.world.registry.ofKind("avatar")) {
      avatars.push({
        entityId: entity.id,
        userId: entity.avatar?.userId ?? "",
        position: { x: entity.transform.x, y: entity.transform.y },
      });
    }
    avatars.sort((left, right) => left.entityId.localeCompare(right.entityId));
    return {
      schemaVersion: 1,
      canvasId: this.canvas.id,
      canvasVersion: this.canvas.version,
      sceneRevision: metadata.sceneRevision ?? 0,
      hostEpoch: metadata.hostEpoch ?? 0,
      checkpointRevision: ++this.checkpointRevision,
      tick: this.world.currentTick,
      capturedAt: new Date().toISOString(),
      normalized,
      items,
      avatars,
    };
  }

  /** Spec 13.3. Normalize behavior state and stop timers before the room sleeps. */
  normalizeForSleep(
    metadata: { sceneRevision?: number; hostEpoch?: number } = {},
  ): CanvasSnapshot {
    this.behaviors.normalizeForSleep();
    for (const entity of this.world.registry.all()) {
      if (entity.rigidBody) {
        this.world.setVelocity(entity.id, { x: 0, y: 0 }, 0);
      }
    }
    return this.snapshot(true, metadata);
  }

  get nextCheckpointRevision(): number {
    return this.checkpointRevision + 1;
  }

  /** Entities whose transform changed since the last delta (spec 19.2). */
  changedEntities(): Entity[] {
    const changed: Entity[] = [];
    for (const entity of this.world.registry.all()) {
      if (entity.kind === "static") continue;
      const key = [
        entity.transform.x.toFixed(3),
        entity.transform.y.toFixed(3),
        entity.transform.rotation.toFixed(3),
        (entity.transform.scale ?? 1).toFixed(3),
        entity.render?.variant ?? "",
        entity.render?.tint?.toString(16) ?? "",
        entity.collisionsDisabled ? "no-collisions" : "collisions",
      ].join(",");
      if (this.lastSentTransforms.get(entity.id) === key) continue;
      this.lastSentTransforms.set(entity.id, key);
      changed.push(entity);
    }
    return changed;
  }

  free(): void {
    this.resolvedConfigByEntityID.clear();
    this.world.free();
  }
}
