/// <reference lib="webworker" />
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

/**
 * The simulation worker. It owns every Rapier handle and the canonical behavior
 * state while hosting. No physics object crosses the worker boundary (spec 15.2).
 */
let simulation: HostSimulation | undefined;
let loop: FixedStepLoop | undefined;
let canvas: CanvasDefinition | undefined;
let definitions: ItemDefinition[] = [];
let tickRate = 60;
let isHost = false;
let localAvatarId: string | undefined;
let running = false;
let renderAccumulatorMs = 0;

const post = (message: SimulationResponse) => self.postMessage(message);

const buildRegistry = (): BehaviorRegistry =>
  new BehaviorRegistry()
    .register(RocketBehavior)
    .register(KickableBehavior)
    .register(PortalBehavior);

const toRenderEntity = (entity: Entity): RenderEntity => ({
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
  quarantined: entity.quarantined,
});

const rebuild = (snapshotSource?: SimulationRequest): void => {
  if (!canvas) return;
  simulation?.free();
  simulation = new HostSimulation(canvas, definitions, buildRegistry(), tickRate);

  if (isHost && snapshotSource && "snapshot" in snapshotSource && snapshotSource.snapshot) {
    simulation.loadSnapshot(snapshotSource.snapshot);
  }
  loop = new FixedStepLoop(tickRate, () => stepOnce());
  loop.reset(performance.now());
};

let lastStats = { hz: 0, driftMs: 0, worstStepMs: 0, behaviorErrors: 0 };

const stepOnce = (): void => {
  if (!simulation) return;
  const result = simulation.step();
  lastStats.behaviorErrors = result.behaviorErrors;
  if (result.effects.length > 0) {
    post({ type: "effects", tick: result.tick, effects: result.effects });
  }
};

const drive = (): void => {
  if (!running || !loop || !simulation) return;
  const now = performance.now();
  const stats = loop.drive(now);
  lastStats = { ...lastStats, hz: stats.hz, driftMs: stats.driftMs, worstStepMs: stats.worstStepMs };

  // The main thread renders at its own rate, so post at about 60 Hz.
  renderAccumulatorMs += 1000 / tickRate;
  if (stats.steps > 0 || renderAccumulatorMs >= 16) {
    renderAccumulatorMs = 0;
    const entities: RenderEntity[] = [];
    let awake = 0;
    for (const entity of simulation.world.registry.all()) {
      if (entity.kind === "static") continue;
      if (entity.rigidBody?.awake) awake++;
      entities.push(toRenderEntity(entity));
    }
    post({
      type: "render",
      tick: simulation.tick,
      isHost,
      entities,
      stats: { ...lastStats, awakeBodies: awake },
    });
  }
  setTimeout(drive, Math.max(1, 1000 / tickRate / 2));
};

self.onmessage = (event: MessageEvent<SimulationRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case "init": {
        canvas = request.canvas;
        definitions = request.definitions;
        tickRate = request.tickRate;
        isHost = request.isHost;
        void RapierWorld.load().then(() => {
          rebuild(request);
          if (request.localAvatar) {
            localAvatarId = request.localAvatar.entityId;
            simulation?.addAvatar(request.localAvatar);
          }
          running = true;
          post({ type: "ready" });
          drive();
        });
        break;
      }

      case "setHost": {
        isHost = request.isHost;
        rebuild(request);
        break;
      }

      case "addItem":
        // A non-host client keeps only static geometry and its own avatar.
        if (isHost) simulation?.addItem(request.instance);
        break;

      case "removeItem":
        simulation?.removeItem(request.entityId);
        break;

      case "addAvatar":
        if (isHost || request.spawn.entityId === localAvatarId) {
          simulation?.addAvatar(request.spawn);
        }
        break;

      case "removeAvatar":
        simulation?.removeAvatar(request.entityId);
        break;

      case "input":
        simulation?.world.setAvatarInput(
          request.entityId,
          request.direction,
          request.intensity,
          request.inputSequence,
        );
        break;

      case "ownerAction":
        simulation?.emit({
          type: "owner.action",
          tick: simulation.tick,
          self: request.entityId,
          action: request.action,
          userId: request.userId,
        });
        break;

      case "moveItem":
        simulation?.world.teleport(
          request.entityId,
          { x: request.transform.x, y: request.transform.y },
          request.transform.rotation,
          { x: 0, y: 0 },
          request.transform.z,
        );
        break;

      case "requestSnapshot": {
        if (!simulation) break;
        const snapshot = request.final
          ? simulation.normalizeForSleep()
          : simulation.snapshot(false);
        post({ type: "snapshot", snapshot, final: request.final });
        break;
      }

      case "stop":
        running = false;
        simulation?.free();
        simulation = undefined;
        break;
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
