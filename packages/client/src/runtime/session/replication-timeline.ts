import type { Vec2 } from "@canvas-physics/core";
import {
  fromJsonBytes,
  type EntityState,
  type FullState,
  type StateDelta,
} from "@canvas-physics/protocol";
import { AvatarReconciler } from "../../net/avatar-reconciler.js";
import { dequantizeTransform, quantizeTransform } from "../../net/quantization.js";
import { InterpolationBuffer } from "../../render/interpolation-buffer.js";
import type { RenderEntity } from "../../simulation/messages.js";
import {
  ObserverSet,
  type Observer,
  type ObserverErrorHandler,
  type SubscriptionOptions,
} from "../observers.js";

export interface CanonicalStateSnapshot {
  readonly tick: number;
  readonly sceneRevision: number;
  readonly entities: readonly Readonly<RenderEntity>[];
}

export interface BehaviorStateSnapshot {
  readonly tick: number;
  readonly states: readonly {
    readonly entityId: string;
    readonly state: unknown;
  }[];
}

export interface ReplicationTimelineOptions {
  readonly sceneRevision: () => number;
  readonly decorate?: (entity: RenderEntity) => RenderEntity;
  readonly onCanonical?: (tick: number, entities: readonly RenderEntity[]) => void;
  readonly onObserverError?: ObserverErrorHandler;
}

export interface EncodedHostFrame {
  readonly entities: EntityState[];
  readonly removedEntityIds: string[];
}

export interface ReplicationTimelineDiagnostics {
  readonly hostEpoch: number;
  readonly tick: number;
  readonly interpolationDepth: number;
  readonly extrapolations: number;
  readonly reconcileError: number;
  readonly acknowledgedInputSequence: number;
  readonly predictionHistoryDepth: number;
  readonly predictedAvatar?: Readonly<Vec2>;
}

/** Sole owner of canonical replication, interpolation, and local prediction history. */
export class ReplicationTimeline {
  private readonly buffer = new InterpolationBuffer();
  private readonly reconciler = new AvatarReconciler();
  private readonly localPredictionHistory = new Map<number, Readonly<Vec2>>();
  private readonly lastSent = new Map<string, SentSample>();
  private readonly lastBehaviorJson = new Map<string, string>();
  private readonly canonicalObservers: ObserverSet<CanonicalStateSnapshot>;
  private readonly behaviorObservers: ObserverSet<BehaviorStateSnapshot>;
  private hostEntitiesValue: RenderEntity[] = [];
  private localPrediction?: RenderEntity;
  private lastReconciledTick?: number;
  private acknowledgedInputSequence = 0;
  private currentTick = 0;
  private hostEpoch = 0;
  private latestCanonicalSnapshot?: CanonicalStateSnapshot;
  private latestBehaviorSnapshot?: BehaviorStateSnapshot;

  constructor(private readonly options: ReplicationTimelineOptions) {
    this.canonicalObservers = new ObserverSet(options.onObserverError);
    this.behaviorObservers = new ObserverSet(options.onObserverError);
  }

  get tick(): number {
    return this.currentTick;
  }

  get hostEntities(): readonly RenderEntity[] {
    return this.hostEntitiesValue;
  }

  get latestEntities(): readonly RenderEntity[] {
    return this.buffer.latest();
  }

  get latestPeerTick(): number | undefined {
    return this.buffer.latestTick;
  }

  get diagnostics(): Readonly<ReplicationTimelineDiagnostics> {
    return Object.freeze({
      hostEpoch: this.hostEpoch,
      tick: this.currentTick,
      interpolationDepth: this.buffer.depth,
      extrapolations: this.buffer.extrapolationCount,
      reconcileError: this.reconciler.lastErrorDistance,
      acknowledgedInputSequence: this.acknowledgedInputSequence,
      predictionHistoryDepth: this.localPredictionHistory.size,
      predictedAvatar: this.localPrediction
        ? Object.freeze({ x: this.localPrediction.x, y: this.localPrediction.y })
        : undefined,
    });
  }

  subscribeCanonical(
    observer: Observer<CanonicalStateSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.canonicalObservers.subscribe(
      observer,
      options,
      this.latestCanonicalSnapshot ? () => this.latestCanonicalSnapshot! : undefined,
    );
  }

  subscribeBehavior(
    observer: Observer<BehaviorStateSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.behaviorObservers.subscribe(
      observer,
      options,
      this.latestBehaviorSnapshot ? () => this.latestBehaviorSnapshot! : undefined,
    );
  }

  clearObservers(): void {
    this.canonicalObservers.clear();
    this.behaviorObservers.clear();
  }

  resetEpoch(hostEpoch: number): void {
    if (hostEpoch < this.hostEpoch) return;
    this.hostEpoch = hostEpoch;
    this.currentTick = 0;
    this.buffer.reset();
    this.reconciler.reset();
    this.localPredictionHistory.clear();
    this.acknowledgedInputSequence = 0;
    this.lastReconciledTick = undefined;
    this.lastSent.clear();
    this.lastBehaviorJson.clear();
  }

  acceptHostFrame(tick: number, entities: RenderEntity[]): void {
    if (tick < this.currentTick) return;
    this.currentTick = tick;
    this.hostEntitiesValue = entities;
    this.publish(tick, entities);
  }

  acceptLocalPredictionFrame(
    tick: number,
    entities: readonly RenderEntity[],
    localAvatarId: string,
  ): void {
    if (tick < this.currentTick) return;
    this.currentTick = tick;
    this.localPrediction = entities.find((entity) => entity.id === localAvatarId);
    if (this.localPrediction) this.recordLocalPrediction(this.localPrediction);
  }

  acceptFullState(state: FullState, tick: number): void {
    if (this.buffer.latestTick !== undefined && tick < this.buffer.latestTick) return;
    const avatars = new Map(state.avatars.map((avatar) => [avatar.entityId, avatar]));
    const entities = state.entities.map((serialized) => {
      const entity = this.decorate(fromEntityState(serialized));
      const avatarState = avatars.get(entity.id);
      return avatarState ? { ...entity, userId: avatarState.userId } : entity;
    });
    this.buffer.push(tick, entities);
    this.publish(tick, entities);
  }

  acceptDelta(delta: StateDelta, tick: number): void {
    if (this.buffer.latestTick !== undefined && tick < this.buffer.latestTick) return;
    const entities = delta.entities.map((serialized) =>
      this.decorate(fromEntityState(serialized)),
    );
    this.buffer.pushDelta(tick, entities, delta.removedEntityIds);
    this.publish(tick, this.buffer.latest());
  }

  frame(nowMs: number, localAvatarId: string, isHost: boolean): RenderEntity[] {
    if (isHost) return this.hostEntitiesValue;

    const sampled = this.buffer.sample(nowMs);
    const remote = sampled.filter((entity) => entity.id !== localAvatarId);
    if (!this.localPrediction) return remote;

    const latestTick = this.buffer.latestTick;
    const canonicalLocal = this.buffer.latest().find(
      (entity) => entity.id === localAvatarId,
    );
    if (
      canonicalLocal &&
      latestTick !== undefined &&
      latestTick !== this.lastReconciledTick
    ) {
      const acknowledged = canonicalLocal.lastProcessedInputSequence ?? 0;
      const predictionAtAcknowledgement = this.localPredictionHistory.get(acknowledged);
      if (predictionAtAcknowledgement) {
        this.reconciler.observe(canonicalLocal, predictionAtAcknowledgement);
        this.acknowledgedInputSequence = Math.max(
          this.acknowledgedInputSequence,
          acknowledged,
        );
        for (const sequence of this.localPredictionHistory.keys()) {
          if (sequence <= acknowledged) this.localPredictionHistory.delete(sequence);
        }
      } else if (
        acknowledged === (this.localPrediction.lastProcessedInputSequence ?? 0)
      ) {
        this.reconciler.observe(canonicalLocal, this.localPrediction);
        this.acknowledgedInputSequence = Math.max(
          this.acknowledgedInputSequence,
          acknowledged,
        );
      }
      this.lastReconciledTick = latestTick;
    }
    const corrected = this.reconciler.correct(this.localPrediction);
    remote.push({
      ...this.localPrediction,
      x: corrected.x,
      y: corrected.y,
      extrapolated: false,
    });
    return remote;
  }

  encodeHostFrame(keyframe: boolean): EncodedHostFrame {
    const source = keyframe ? this.hostEntitiesValue : this.changedEntities();
    const entities = source.map((entity) =>
      toEntityState(entity, this.behaviorBytes(entity, keyframe), keyframe),
    );
    if (keyframe) {
      this.lastSent.clear();
      for (const entity of this.hostEntitiesValue) {
        this.lastSent.set(entity.id, sentSample(entity));
      }
      return { entities, removedEntityIds: [] };
    }
    return { entities, removedEntityIds: this.removedEntityIds() };
  }

  canonicalAvatar(entityId: string, isHost: boolean): RenderEntity | undefined {
    return (isHost ? this.hostEntitiesValue : this.buffer.latest())
      .find((entity) => entity.id === entityId);
  }

  private decorate(entity: RenderEntity): RenderEntity {
    return this.options.decorate?.(entity) ?? entity;
  }

  private publish(tick: number, source: readonly RenderEntity[]): void {
    this.options.onCanonical?.(tick, source);
    const entities = Object.freeze(
      source.map((entity) => Object.freeze({
        ...entity,
        behaviorState: immutableValue(entity.behaviorState),
      })),
    );
    const canonical = Object.freeze({
      tick,
      sceneRevision: this.options.sceneRevision(),
      entities,
    });
    this.latestCanonicalSnapshot = canonical;
    const states = Object.freeze(
      entities
        .filter((entity) => entity.behaviorState !== undefined)
        .map((entity) => Object.freeze({
          entityId: entity.id,
          state: entity.behaviorState,
        })),
    );
    const behavior = Object.freeze({ tick, states });
    this.latestBehaviorSnapshot = behavior;
    this.canonicalObservers.publish(canonical);
    this.behaviorObservers.publish(behavior);
  }

  private changedEntities(): RenderEntity[] {
    const changed: RenderEntity[] = [];
    for (const entity of this.hostEntitiesValue) {
      const before = this.lastSent.get(entity.id);
      if (!before || movedSince(before, entity)) {
        changed.push(entity);
        this.lastSent.set(entity.id, sentSample(entity));
      }
    }
    return changed;
  }

  private removedEntityIds(): string[] {
    const present = new Set(this.hostEntitiesValue.map((entity) => entity.id));
    const removed: string[] = [];
    for (const id of this.lastSent.keys()) {
      if (present.has(id)) continue;
      removed.push(id);
      this.lastSent.delete(id);
      this.lastBehaviorJson.delete(id);
    }
    return removed;
  }

  private behaviorBytes(entity: RenderEntity, keyframe: boolean): Uint8Array {
    if (entity.behaviorState === undefined) {
      this.lastBehaviorJson.delete(entity.id);
      return new Uint8Array();
    }
    const json = JSON.stringify(entity.behaviorState);
    const previous = this.lastBehaviorJson.get(entity.id);
    this.lastBehaviorJson.set(entity.id, json);
    if (!keyframe && previous === json) return new Uint8Array();
    return new TextEncoder().encode(json);
  }

  private recordLocalPrediction(entity: Readonly<RenderEntity>): void {
    const sequence = entity.lastProcessedInputSequence ?? 0;
    this.localPredictionHistory.set(
      sequence,
      Object.freeze({ x: entity.x, y: entity.y }),
    );
    while (this.localPredictionHistory.size > 128) {
      const oldest = this.localPredictionHistory.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.localPredictionHistory.delete(oldest);
    }
  }
}

const immutableValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableValue(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, immutableValue(item)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
};

interface SentSample {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  z: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  variant?: string;
  tint?: number;
  animation?: string;
  animationEpoch?: number;
  disabled?: boolean;
  quarantined?: boolean;
  teleportEpoch?: number;
  respawning?: boolean;
  isolated?: boolean;
  collisionsDisabled?: boolean;
}

const sentSample = (entity: RenderEntity): SentSample => ({
  x: entity.x,
  y: entity.y,
  rotation: entity.rotation,
  scale: entity.scale ?? 1,
  z: entity.z ?? 0,
  vx: entity.vx,
  vy: entity.vy,
  angularVelocity: entity.angularVelocity,
  variant: entity.variant,
  tint: entity.tint,
  animation: entity.animation,
  animationEpoch: entity.animationEpoch,
  disabled: entity.disabled,
  quarantined: entity.quarantined,
  teleportEpoch: entity.teleportEpoch,
  respawning: entity.respawning,
  isolated: entity.isolated,
  collisionsDisabled: entity.collisionsDisabled,
});

const POSITION_EPSILON = 0.01;
const ROTATION_EPSILON = 0.005;
const VELOCITY_EPSILON = 0.05;

const movedSince = (before: SentSample, now: RenderEntity): boolean =>
  Math.abs(before.x - now.x) > POSITION_EPSILON ||
  Math.abs(before.y - now.y) > POSITION_EPSILON ||
  Math.abs(before.z - (now.z ?? 0)) > POSITION_EPSILON ||
  Math.abs(before.rotation - now.rotation) > ROTATION_EPSILON ||
  Math.abs(before.scale - (now.scale ?? 1)) > ROTATION_EPSILON ||
  Math.abs(before.vx - now.vx) > VELOCITY_EPSILON ||
  Math.abs(before.vy - now.vy) > VELOCITY_EPSILON ||
  Math.abs(before.angularVelocity - now.angularVelocity) > VELOCITY_EPSILON ||
  before.variant !== now.variant ||
  before.tint !== now.tint ||
  before.animation !== now.animation ||
  before.animationEpoch !== now.animationEpoch ||
  before.disabled !== now.disabled ||
  before.quarantined !== now.quarantined ||
  before.teleportEpoch !== now.teleportEpoch ||
  before.respawning !== now.respawning ||
  before.isolated !== now.isolated ||
  before.collisionsDisabled !== now.collisionsDisabled;

const toEntityState = (
  entity: RenderEntity,
  behaviorStateJson: Uint8Array,
  keyframe = true,
): EntityState => ({
  entityId: entity.id,
  lastProcessedInputSequence: entity.lastProcessedInputSequence ?? 0,
  spriteVariant: entity.variant ?? "",
  spriteAnimation: entity.animation ?? "",
  animationEpoch: entity.animationEpoch ?? 0,
  behaviorStateJson,
  quarantined: entity.quarantined ?? false,
  definitionId: keyframe ? entity.definitionId : "",
  disabled: entity.disabled ?? false,
  teleportEpoch: entity.teleportEpoch ?? 0,
  respawning: entity.respawning ?? false,
  itemIsolated: entity.isolated ?? false,
  spriteTint: entity.tint ?? 0,
  hasSpriteTint: entity.tint !== undefined,
  itemCollisionsDisabled: entity.collisionsDisabled ?? false,
  quantizedTransform: quantizeTransform({
    x: entity.x,
    y: entity.y,
    rotation: entity.rotation,
    scale: entity.scale ?? 1,
    vx: entity.vx,
    vy: entity.vy,
    angularVelocity: entity.angularVelocity,
    z: entity.z,
    vz: 0,
  }),
});

const fromEntityState = (state: EntityState): RenderEntity => {
  const transform = dequantizeTransform(state.quantizedTransform!);
  return {
    id: state.entityId,
    kind: state.entityId.startsWith("avatar:") ? "avatar" : "item",
    definitionId: state.definitionId,
    x: transform.x,
    y: transform.y,
    rotation: transform.rotation,
    scale: transform.scale || 1,
    z: transform.z || undefined,
    vx: transform.vx,
    vy: transform.vy,
    angularVelocity: transform.angularVelocity,
    variant: state.spriteVariant || undefined,
    animation: state.spriteAnimation || undefined,
    animationEpoch: state.animationEpoch || undefined,
    lastProcessedInputSequence: state.lastProcessedInputSequence,
    behaviorState: fromJsonBytes(state.behaviorStateJson),
    quarantined: state.quarantined,
    disabled: state.disabled,
    teleportEpoch: state.teleportEpoch,
    respawning: state.respawning,
    isolated: state.itemIsolated,
    tint: state.hasSpriteTint ? state.spriteTint : undefined,
    collisionsDisabled: state.itemCollisionsDisabled,
  };
};
