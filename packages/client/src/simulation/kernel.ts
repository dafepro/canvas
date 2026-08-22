import {
  BehaviorRegistry,
  KickableBehavior,
  PortalBehavior,
  RocketBehavior,
  type CanvasDefinition,
  type Entity,
  type ItemDefinition,
} from "@canvas-physics/core";
import { FixedStepLoop } from "./fixed-step-loop.js";
import { HostSimulation } from "./host-simulation.js";
import { RapierWorld } from "./rapier-world.js";
import type {
  RenderEntity,
  SimulationRequest,
  SimulationResponse,
} from "./messages.js";

const buildRegistry = (): BehaviorRegistry =>
  new BehaviorRegistry()
    .register(RocketBehavior)
    .register(KickableBehavior)
    .register(PortalBehavior);

const toRenderEntity = (entity: Entity, behaviorState?: unknown): RenderEntity => ({
  id: entity.id,
  kind: entity.kind,
  definitionId: entity.render?.definitionId ?? "",
  x: entity.transform.x,
  y: entity.transform.y,
  rotation: entity.transform.rotation,
  z: entity.transform.z,
  vx: entity.rigidBody?.velocity.x ?? 0,
  vy: entity.rigidBody?.velocity.y ?? 0,
  angularVelocity: entity.rigidBody?.angularVelocity ?? 0,
  variant: entity.render?.variant,
  animation: entity.render?.animation,
  userId: entity.avatar?.userId,
  ownerUserId: entity.ownership?.ownerUserId,
  lastProcessedInputSequence: entity.avatar?.lastProcessedInputSeq,
  behaviorState,
  quarantined: entity.quarantined,
});

/**
 * The simulation kernel. It owns every Rapier handle and the canonical behavior
 * state while hosting. No physics object leaves this class (spec 15.2).
 *
 * The kernel holds no reference to a worker, so the same code runs inside the
 * simulation worker in a browser and inside a test process.
 */
export class SimulationKernel {
  private simulation?: HostSimulation;
  private loop?: FixedStepLoop;
  private canvas?: CanvasDefinition;
  private definitions: ItemDefinition[] = [];
  private tickRate = 60;
  private isHost = false;
  private localAvatarId?: string;
  private running = false;
  private renderAccumulatorMs = 0;
  private driveTimer?: ReturnType<typeof setTimeout>;
  private lastStats = { hz: 0, driftMs: 0, worstStepMs: 0, behaviorErrors: 0 };

  constructor(private readonly post: (message: SimulationResponse) => void) {}

  handle(request: SimulationRequest): void {
    try {
      this.dispatch(request);
    } catch (error) {
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dispatch(request: SimulationRequest): void {
    switch (request.type) {
      case "init": {
        this.canvas = request.canvas;
        this.definitions = request.definitions;
        this.tickRate = request.tickRate;
        this.isHost = request.isHost;
        void RapierWorld.load().then(() => {
          this.rebuild(request);
          if (request.localAvatar) {
            this.localAvatarId = request.localAvatar.entityId;
            this.simulation?.addAvatar(request.localAvatar);
          }
          this.running = true;
          this.post({ type: "ready" });
          this.drive();
        });
        break;
      }

      case "setHost": {
        this.isHost = request.isHost;
        this.rebuild(request);
        break;
      }

      case "addItem":
        // A non-host client keeps only static geometry and its own avatar.
        if (this.isHost) this.simulation?.addItem(request.instance);
        break;

      case "removeItem":
        this.simulation?.removeItem(request.entityId);
        break;

      case "addAvatar":
        if (this.isHost || request.spawn.entityId === this.localAvatarId) {
          this.simulation?.addAvatar(request.spawn);
        }
        break;

      case "removeAvatar":
        this.simulation?.removeAvatar(request.entityId);
        break;

      case "input":
        this.simulation?.world.setAvatarInput(
          request.entityId,
          request.direction,
          request.intensity,
          request.inputSequence,
        );
        break;

      case "ownerAction":
        this.simulation?.emit({
          type: "owner.action",
          tick: this.simulation.tick,
          self: request.entityId,
          action: request.action,
          userId: request.userId,
        });
        break;

      case "moveItem":
        this.simulation?.world.teleport(
          request.entityId,
          { x: request.transform.x, y: request.transform.y },
          request.transform.rotation,
          { x: 0, y: 0 },
          request.transform.z,
        );
        break;

      case "requestSnapshot": {
        if (!this.simulation) break;
        const snapshot = request.final
          ? this.simulation.normalizeForSleep()
          : this.simulation.snapshot(false);
        this.post({ type: "snapshot", snapshot, final: request.final });
        break;
      }

      case "stop":
        this.stop();
        break;
    }
  }

  /** Stops the loop and frees the physics world. */
  stop(): void {
    this.running = false;
    if (this.driveTimer) clearTimeout(this.driveTimer);
    this.driveTimer = undefined;
    this.simulation?.free();
    this.simulation = undefined;
  }

  private rebuild(snapshotSource?: SimulationRequest): void {
    if (!this.canvas) return;
    this.simulation?.free();
    this.simulation = new HostSimulation(
      this.canvas,
      this.definitions,
      buildRegistry(),
      this.tickRate,
    );

    if (
      this.isHost &&
      snapshotSource &&
      "snapshot" in snapshotSource &&
      snapshotSource.snapshot
    ) {
      this.simulation.loadSnapshot(snapshotSource.snapshot);
    }
    this.loop = new FixedStepLoop(this.tickRate, () => this.stepOnce());
    this.loop.reset(performance.now());
  }

  private stepOnce(): void {
    if (!this.simulation) return;
    const result = this.simulation.step();
    this.lastStats.behaviorErrors = result.behaviorErrors;
    if (result.effects.length > 0) {
      this.post({ type: "effects", tick: result.tick, effects: result.effects });
    }
  }

  private drive(): void {
    if (!this.running || !this.loop || !this.simulation) return;
    const stats = this.loop.drive(performance.now());
    this.lastStats = {
      ...this.lastStats,
      hz: stats.hz,
      driftMs: stats.driftMs,
      worstStepMs: stats.worstStepMs,
    };

    // The main thread renders at its own rate, so post at about 60 Hz.
    this.renderAccumulatorMs += 1000 / this.tickRate;
    if (stats.steps > 0 || this.renderAccumulatorMs >= 16) {
      this.renderAccumulatorMs = 0;
      const entities: RenderEntity[] = [];
      let awake = 0;
      for (const entity of this.simulation.world.registry.all()) {
        if (entity.kind === "static") continue;
        if (entity.rigidBody?.awake) awake++;
        // Spec 20. A client that joins during a workflow needs the state, not
        // only the sprite variant.
        entities.push(
          toRenderEntity(entity, this.simulation.behaviors.slot(entity.id)?.state),
        );
      }
      this.post({
        type: "render",
        tick: this.simulation.tick,
        isHost: this.isHost,
        entities,
        stats: { ...this.lastStats, awakeBodies: awake },
      });
    }
    this.driveTimer = setTimeout(
      () => this.drive(),
      Math.max(1, 1000 / this.tickRate / 2),
    );
  }
}
