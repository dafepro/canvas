import {
  resolveItemConfig,
  type CanvasDefinition,
  type CanvasSnapshot,
  type EffectEmission,
  type ItemDefinition,
  type SnapshotItem,
  type Transform,
  type Vec2,
} from "@canvas-physics/core";
import {
  DurableCommandKind,
  fromJsonBytes,
  toJsonBytes,
  type DurableCommand,
  type EntityState,
} from "@canvas-physics/protocol";
import { AvatarReconciler } from "../net/avatar-reconciler.js";
import { RoomClient } from "../net/room-client.js";
import type { RoomTransport } from "../net/transport.js";
import { WebSocketRoomTransport } from "../net/websocket-transport.js";
import { InterpolationBuffer } from "../render/interpolation-buffer.js";
import { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity, SimulationResponse } from "../simulation/messages.js";

/** One sample of movement intent, from a pointer, a key, or a test. */
export interface InputIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
  /** Addendum A1. True while the player asks for a disabled avatar. */
  disabled?: boolean;
}

const NO_INTENT: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

/** Send rates from spec 10.3. */
export interface RoomSessionRates {
  inputHz?: number;
  deltaHz?: number;
  keyframeHz?: number;
  checkpointHz?: number;
}

export interface RoomSessionOptions {
  canvasId: string;
  serverUrl: string;
  userId: string;
  displayName: string;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  /** Defaults to a worker driver. A test passes `SimulationDriver.local()`. */
  driver?: SimulationDriver;
  rates?: RoomSessionRates;
  /** Movement intent for the local avatar. Defaults to no movement. */
  intent?: () => InputIntent;
  /** Runs once the room accepts the join, before the send loops start. */
  onJoined?: (
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ) => void | Promise<void>;
  onEffect?: (emission: EffectEmission) => void;
  onError?: (message: string) => void;
}

export interface SessionDiagnostics {
  status: string;
  isHost: boolean;
  hostEpoch: number;
  hostClientId: string;
  clientId: string;
  peers: number;
  tick: number;
  simulationHz: number;
  driftMs: number;
  worstStepMs: number;
  awakeBodies: number;
  activeColliders: number;
  interpolationDepth: number;
  extrapolations: number;
  reconcileError: number;
  sceneRevision: number;
  itemCount: number;
  lastRejection?: string;
  /** Spec 22.1 and 19.3. Realtime traffic, measured over the last second. */
  inboundBytesPerSecond: number;
  outboundBytesPerSecond: number;
  inboundMessagesPerSecond: number;
  outboundMessagesPerSecond: number;
  droppedOutbound: number;
  /** Spec 22.1. Host lease changes this client observed, and the last reason. */
  hostMigrations: number;
  lastMigrationReason?: string;
  quarantined: number;
}

/**
 * Coordination, simulation, and the send rates of spec 10.3, with no renderer
 * and no DOM. `CanvasRuntime` adds the renderer and the input controllers on
 * top of one session.
 */
export class RoomSession {
  readonly client: RoomClient;
  readonly driver: SimulationDriver;
  private readonly buffer = new InterpolationBuffer();
  private readonly reconciler = new AvatarReconciler();
  private canvasDefinition?: CanvasDefinition;
  private timers: ReturnType<typeof setInterval>[] = [];
  private localAvatarId = "";
  private inputSequence = 0;
  private hostEntities: RenderEntity[] = [];
  private localPrediction?: RenderEntity;
  private currentTick = 0;
  private stats = {
    hz: 0,
    driftMs: 0,
    worstStepMs: 0,
    awakeBodies: 0,
    behaviorErrors: 0,
    activeColliders: 0,
  };
  private lastRejection?: string;
  private itemCount = 0;
  private commandCounter = 0;
  private running = false;
  private readonly lastBehaviorJson = new Map<string, string>();
  private readonly countdowns = new Set<string>();
  private readonly lastSent = new Map<string, SentSample>();
  private hostMigrations = 0;
  private lastMigrationReason?: string;
  private quarantinedCount = 0;
  /** Spec 22.1. One sample of the transport counters, taken every second. */
  private trafficMark = {
    atMs: 0,
    inboundBytes: 0,
    outboundBytes: 0,
    inboundMessages: 0,
    outboundMessages: 0,
  };
  private trafficRate = {
    inboundBytesPerSecond: 0,
    outboundBytesPerSecond: 0,
    inboundMessagesPerSecond: 0,
    outboundMessagesPerSecond: 0,
  };

  constructor(private readonly options: RoomSessionOptions) {
    const transport = options.transport ?? new WebSocketRoomTransport();
    this.driver = options.driver ?? SimulationDriver.spawn();
    this.client = new RoomClient({
      transport,
      join: {
        canvasId: options.canvasId,
        userId: options.userId,
        displayName: options.displayName,
        serverUrl: options.serverUrl,
      },
    });
    this.wireClient();
    this.driver.onMessage((message) => this.onSimulation(message));
  }

  get canvas(): CanvasDefinition | undefined {
    return this.canvasDefinition;
  }

  get tick(): number {
    return this.currentTick;
  }

  get avatarId(): string {
    return this.localAvatarId;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.client.connect();
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.driver.terminate();
    this.client.close();
  }

  // ---------- coordination ----------

  private wireClient(): void {
    this.client.on("joined", (result) => {
      void this.onJoined(result.canvas, result.snapshot, result.roomWasSleeping);
    });

    this.client.on("hostGranted", (_epoch, snapshot) => {
      this.buffer.reset();
      this.reconciler.reset();
      this.driver.send({ type: "setHost", isHost: true, snapshot });
      // Rebuilding the world drops the local avatar, so add it again.
      this.spawnLocalAvatar();
      this.itemCount = snapshot?.items.length ?? 0;
    });

    this.client.on("hostChanged", (_epoch, hostClientId, reason) => {
      // Spec 11.2. Clear stale interpolation history when the epoch changes.
      this.hostMigrations++;
      this.lastMigrationReason = reason || undefined;
      this.buffer.reset();
      this.reconciler.reset();
      if (hostClientId !== this.client.clientId) {
        this.driver.send({ type: "setHost", isHost: false });
        this.spawnLocalAvatar();
      }
    });

    this.client.on("fullState", (state, _epoch, tick) => {
      if (this.client.isHost) return;
      const entities = state.entities.map(fromEntityState);
      this.buffer.push(tick, entities);
      this.syncCountdowns(entities, tick);
      this.itemCount = state.entities.length;
    });

    this.client.on("stateDelta", (delta, _epoch, tick) => {
      if (this.client.isHost) return;
      const entities = delta.entities.map(fromEntityState);
      this.buffer.pushDelta(tick, entities, delta.removedEntityIds);
      this.syncCountdowns(entities, tick);
    });

    this.client.on("effect", (event) => {
      if (event.effect === "countdown") {
        if (event.mode === "start") this.countdowns.add(event.entityId);
        if (event.mode === "stop") this.countdowns.delete(event.entityId);
      }
      this.options.onEffect?.({
        tick: this.currentTick,
        entityId: event.entityId,
        effect: event.effect,
        mode: (event.mode as "oneShot" | "start" | "stop") || "oneShot",
        params: undefined,
      });
    });

    this.client.on("playerInput", (input, fromClientId) => {
      if (!this.client.isHost) return;
      this.driver.send({
        type: "input",
        entityId: avatarEntityId(fromClientId),
        direction: input.direction ?? { x: 0, y: 0 },
        intensity: input.intensity,
        inputSequence: input.inputSequence,
        disabled: input.avatarDisabled,
      });
    });

    this.client.on("presence", (peers) => {
      if (!this.client.isHost) return;
      // The host keeps one avatar for each connected client.
      for (const peer of peers) {
        this.driver.send({
          type: "addAvatar",
          spawn: {
            entityId: avatarEntityId(peer.clientId),
            clientId: peer.clientId,
            userId: peer.userId,
            position: this.spawnPosition(),
          },
        });
      }
    });

    this.client.on("durableAccepted", (command, _revision, itemJson) => {
      this.applyAcceptedCommand(command, itemJson as SnapshotItem | undefined);
    });

    this.client.on("durableRejected", (_command, reason) => {
      this.lastRejection = reason;
      this.options.onError?.(reason);
    });

    this.client.on("error", (code, message) => {
      this.lastRejection = `${code}: ${message}`;
      this.options.onError?.(this.lastRejection);
    });
  }

  private spawnPosition(): Vec2 {
    const spawn = this.canvasDefinition?.spawnPoints[0]?.position;
    if (spawn) {
      // Spread avatars a little so they do not stack on one point.
      return { x: spawn.x + (Math.random() - 0.5) * 6, y: spawn.y };
    }
    return { x: 10, y: 10 };
  }

  private async onJoined(
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ): Promise<void> {
    if (this.canvasDefinition) return;
    this.canvasDefinition = canvas;
    this.localAvatarId = avatarEntityId(this.client.clientId);
    this.itemCount = snapshot.items.length;

    await this.options.onJoined?.(canvas, snapshot, wasSleeping);

    this.driver.send({
      type: "init",
      canvas,
      definitions: this.options.definitions,
      tickRate: this.client.tickRate,
      isHost: this.client.isHost,
      snapshot: this.client.isHost ? snapshot : undefined,
      localAvatar: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.options.userId,
        position: this.spawnPosition(),
      },
    });

    this.startSendLoops();
  }

  private spawnLocalAvatar(): void {
    if (!this.localAvatarId) return;
    this.driver.send({
      type: "addAvatar",
      spawn: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.options.userId,
        position: this.spawnPosition(),
      },
    });
  }

  // ---------- loops ----------

  private startSendLoops(): void {
    const rates = this.options.rates ?? {};
    const inputHz = rates.inputHz ?? 30;
    const deltaHz = rates.deltaHz ?? 15;
    const keyframeHz = rates.keyframeHz ?? 2;
    const checkpointHz = rates.checkpointHz ?? 1;

    this.timers.push(
      setInterval(() => this.sendInput(), 1000 / inputHz),
      setInterval(() => this.sendDelta(false), 1000 / deltaHz),
      setInterval(() => this.sendDelta(true), 1000 / keyframeHz),
      setInterval(() => this.requestCheckpoint(), 1000 / checkpointHz),
    );
  }

  private sendInput(): void {
    const intent = this.options.intent?.() ?? NO_INTENT;
    this.inputSequence++;
    const disabled = intent.disabled === true;
    // The host applies its own input directly; a peer sends it through the relay.
    this.driver.send({
      type: "input",
      entityId: this.localAvatarId,
      direction: intent.direction,
      intensity: intent.intensity,
      inputSequence: this.inputSequence,
      disabled,
    });
    if (!this.client.isHost) {
      this.client.sendInput({
        inputSequence: this.inputSequence,
        direction: intent.direction,
        intensity: intent.intensity,
        clientTimeUnixMs: Date.now(),
        held: intent.held,
        avatarDisabled: disabled,
      });
    }
  }

  private sendDelta(keyframe: boolean): void {
    if (!this.client.isHost || this.hostEntities.length === 0) return;
    const source = keyframe ? this.hostEntities : this.changedEntities();
    const entities = source.map((entity) =>
      toEntityState(entity, this.behaviorBytes(entity, keyframe), keyframe),
    );
    if (keyframe) {
      this.client.sendFullState(
        {
          entities,
          avatars: this.hostEntities
            .filter((entity) => entity.kind === "avatar")
            .map((entity) => ({
              entityId: entity.id,
              clientId: clientIdOf(entity.id),
              userId: entity.userId ?? "",
              displayName: entity.userId ?? "",
            })),
          sceneRevision: this.client.sceneRevision,
          tickRate: this.client.tickRate,
        },
        this.currentTick,
      );
      // A keyframe carries every entity, so the delta filter starts again here.
      this.lastSent.clear();
      for (const entity of this.hostEntities) {
        this.lastSent.set(entity.id, sentSample(entity));
      }
      return;
    }
    const removedEntityIds = this.removedEntityIds();
    if (entities.length === 0 && removedEntityIds.length === 0) return;
    this.client.sendStateDelta(
      { entities, removedEntityIds, sceneRevision: this.client.sceneRevision },
      this.currentTick,
    );
  }

  /**
   * Spec 19.2, rule 6. A delta carries only an entity that changed since the
   * last delta. A body at rest costs no bytes, and the 2 Hz keyframe repairs a
   * client that missed a change.
   */
  private changedEntities(): RenderEntity[] {
    const changed: RenderEntity[] = [];
    for (const entity of this.hostEntities) {
      const before = this.lastSent.get(entity.id);
      if (!before || movedSince(before, entity)) {
        changed.push(entity);
        this.lastSent.set(entity.id, sentSample(entity));
      }
    }
    return changed;
  }

  private removedEntityIds(): string[] {
    const present = new Set(this.hostEntities.map((entity) => entity.id));
    const removed: string[] = [];
    for (const id of this.lastSent.keys()) {
      if (present.has(id)) continue;
      removed.push(id);
      this.lastSent.delete(id);
    }
    return removed;
  }

  /**
   * Spec 20. A keyframe always carries the behavior state, so a client that
   * joins during a workflow can show it. A delta carries it only after a change,
   * which keeps the 15 Hz packet small.
   */
  private behaviorBytes(entity: RenderEntity, keyframe: boolean): Uint8Array {
    if (entity.behaviorState === undefined) {
      this.lastBehaviorJson.delete(entity.id);
      return new Uint8Array();
    }
    const json = JSON.stringify(entity.behaviorState);
    const previous = this.lastBehaviorJson.get(entity.id);
    this.lastBehaviorJson.set(entity.id, json);
    if (!keyframe && previous === json) return new Uint8Array();
    return toJsonBytes(entity.behaviorState);
  }

  private requestCheckpoint(): void {
    if (!this.client.isHost) return;
    this.driver.send({ type: "requestSnapshot", final: false });
  }

  /**
   * The entities to draw at `nowMs`. The host draws its own world. A peer draws
   * the interpolated remote state plus its reconciled local avatar.
   */
  entitiesToDraw(nowMs: number): RenderEntity[] {
    if (this.client.isHost) return this.hostEntities;

    const sampled = this.buffer.sample(nowMs);
    const remote = sampled.filter((entity) => entity.id !== this.localAvatarId);
    const canonicalLocal = sampled.find((entity) => entity.id === this.localAvatarId);

    if (this.localPrediction) {
      if (canonicalLocal) {
        this.reconciler.observe(canonicalLocal, this.localPrediction);
      }
      const corrected = this.reconciler.correct(this.localPrediction);
      remote.push({
        ...this.localPrediction,
        x: corrected.x,
        y: corrected.y,
        extrapolated: false,
      });
    }
    return remote;
  }

  /**
   * Spec 20. The effect that starts a countdown reaches only the clients that
   * were present. A client that joins later reads the remaining time from the
   * behavior state instead.
   */
  private syncCountdowns(entities: RenderEntity[], tick: number): void {
    for (const entity of entities) {
      const state = entity.behaviorState as
        | { phase?: string; armedAtTick?: number; countdownTicks?: number }
        | undefined;
      if (!state?.phase) continue;
      const arming = state.phase === "arming";
      const shown = this.countdowns.has(entity.id);
      if (arming && !shown) {
        const remainingTicks =
          (state.armedAtTick ?? 0) + (state.countdownTicks ?? 0) - tick;
        if (remainingTicks <= 0) continue;
        this.countdowns.add(entity.id);
        this.options.onEffect?.({
          tick,
          entityId: entity.id,
          effect: "countdown",
          mode: "start",
          params: { seconds: remainingTicks / this.client.tickRate },
        });
      } else if (!arming && shown) {
        this.countdowns.delete(entity.id);
        this.options.onEffect?.({
          tick,
          entityId: entity.id,
          effect: "countdown",
          mode: "stop",
        });
      }
    }
  }

  /** Spec 11.4. The runtime reports page visibility; the session yields. */
  setPageVisible(visible: boolean): void {
    this.client.health.pageVisible = visible;
    if (!visible && this.client.isHost) this.client.yieldHost("page_hidden");
    this.client.setHostEligible(visible);
  }

  // ---------- simulation messages ----------

  private onSimulation(message: SimulationResponse): void {
    switch (message.type) {
      case "render": {
        this.currentTick = message.tick;
        this.stats = { ...message.stats };
        this.client.health.simulationHz = message.stats.hz;
        this.client.health.workerDriftMs = message.stats.driftMs;
        if (this.client.isHost) {
          this.hostEntities = message.entities;
          this.itemCount = message.entities.filter((e) => e.kind === "item").length;
          // Spec 22.1. The host is the only client that can quarantine a body.
          this.quarantinedCount = message.entities.filter((e) => e.quarantined).length;
        } else {
          this.localPrediction = message.entities.find(
            (entity) => entity.id === this.localAvatarId,
          );
        }
        break;
      }
      case "effects":
        for (const effect of message.effects) {
          this.options.onEffect?.(effect);
          if (this.client.isHost) {
            this.client.sendEffect(
              {
                entityId: effect.entityId,
                effect: effect.effect,
                mode: effect.mode,
                paramsJson: effect.params ? toJsonBytes(effect.params) : new Uint8Array(),
              },
              message.tick,
            );
          }
        }
        break;
      case "snapshot":
        this.client.sendCheckpoint(
          message.snapshot,
          message.snapshot.checkpointRevision,
          message.final,
        );
        break;
      case "error":
        this.lastRejection = `simulation: ${message.message}`;
        this.options.onError?.(this.lastRejection);
        break;
    }
  }

  // ---------- durable mutations ----------

  /** Spec 14.1. Every durable edit goes through the backend. */
  spawnItem(definitionId: string, at: Vec2, rotation = 0): void {
    const definition = this.options.definitions.find(
      (candidate) => candidate.definitionId === definitionId,
    );
    if (!definition || !this.canvasDefinition) return;
    const config = resolveItemConfig(
      definition as ItemDefinition<Record<string, unknown>>,
      {
        width: this.canvasDefinition.size.width,
        height: this.canvasDefinition.size.height,
        orientation: this.canvasDefinition.orientation,
      },
    );
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_SPAWN_ITEM,
      entityId: "",
      definitionId,
      definitionVersion: definition.version,
      position: at,
      rotation,
      z: 0,
      configJson: toJsonBytes(config),
      preview: false,
    });
  }

  moveItem(entityId: string, transform: Transform, preview = false): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_MOVE_ITEM,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: { x: transform.x, y: transform.y },
      rotation: transform.rotation,
      z: transform.z ?? 0,
      configJson: new Uint8Array(),
      preview,
    });
  }

  deleteItem(entityId: string): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_DELETE_ITEM,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: { x: 0, y: 0 },
      rotation: 0,
      z: 0,
      configJson: new Uint8Array(),
      preview: false,
    });
  }

  private nextCommandId(): string {
    return `${this.client.clientId}-${++this.commandCounter}`;
  }

  private applyAcceptedCommand(command: DurableCommand, item?: SnapshotItem): void {
    if (!this.client.isHost) return;
    switch (command.kind) {
      case DurableCommandKind.DURABLE_SPAWN_ITEM:
        this.driver.send({
          type: "addItem",
          instance: {
            entityId: command.entityId,
            canvasId: this.options.canvasId,
            definitionId: command.definitionId,
            definitionVersion: command.definitionVersion,
            // The server owns the record, so its item wins over the command.
            ownerUserId: item?.ownerUserId ?? this.options.userId,
            transform: item?.transform ?? {
              x: command.position?.x ?? 0,
              y: command.position?.y ?? 0,
              rotation: command.rotation,
              z: command.z || undefined,
            },
            resolvedConfig:
              item?.resolvedConfig ??
              JSON.parse(
                new TextDecoder().decode(command.configJson || new Uint8Array([123, 125])),
              ),
            createdAt: new Date().toISOString(),
            sceneRevision: this.client.sceneRevision,
          },
        });
        break;
      case DurableCommandKind.DURABLE_DELETE_ITEM:
        this.driver.send({ type: "removeItem", entityId: command.entityId });
        break;
      case DurableCommandKind.DURABLE_MOVE_ITEM:
      case DurableCommandKind.DURABLE_ROTATE_ITEM:
        this.driver.send({
          type: "moveItem",
          entityId: command.entityId,
          transform: {
            x: command.position?.x ?? 0,
            y: command.position?.y ?? 0,
            rotation: command.rotation,
            z: command.z || undefined,
          },
          preview: command.preview,
        });
        break;
    }
  }

  /**
   * Spec 22.1 and 19.3. The counters of the transport are cumulative, so a rate
   * needs two samples. One sample per second is enough for a budget check and
   * it costs nothing between samples.
   */
  private trafficRates(): typeof this.trafficRate {
    const now = Date.now();
    const traffic = this.client.traffic;
    if (this.trafficMark.atMs === 0) {
      this.trafficMark = { atMs: now, ...pickCounters(traffic) };
      return this.trafficRate;
    }
    const elapsedMs = now - this.trafficMark.atMs;
    if (elapsedMs < 1000) return this.trafficRate;
    const perSecond = 1000 / elapsedMs;
    this.trafficRate = {
      inboundBytesPerSecond:
        (traffic.inboundBytes - this.trafficMark.inboundBytes) * perSecond,
      outboundBytesPerSecond:
        (traffic.outboundBytes - this.trafficMark.outboundBytes) * perSecond,
      inboundMessagesPerSecond:
        (traffic.inboundMessages - this.trafficMark.inboundMessages) * perSecond,
      outboundMessagesPerSecond:
        (traffic.outboundMessages - this.trafficMark.outboundMessages) * perSecond,
    };
    this.trafficMark = { atMs: now, ...pickCounters(traffic) };
    return this.trafficRate;
  }

  diagnostics(): SessionDiagnostics {
    return {
      status: this.client.isHost ? "host" : "peer",
      isHost: this.client.isHost,
      hostEpoch: this.client.hostEpoch,
      hostClientId: this.client.hostClientId,
      clientId: this.client.clientId,
      peers: this.client.peers.length,
      tick: this.currentTick,
      simulationHz: this.stats.hz,
      driftMs: this.stats.driftMs,
      worstStepMs: this.stats.worstStepMs,
      awakeBodies: this.stats.awakeBodies,
      activeColliders: this.stats.activeColliders,
      interpolationDepth: this.buffer.depth,
      extrapolations: this.buffer.extrapolationCount,
      reconcileError: this.reconciler.lastErrorDistance,
      sceneRevision: this.client.sceneRevision,
      itemCount: this.itemCount,
      lastRejection: this.lastRejection,
      ...this.trafficRates(),
      droppedOutbound: this.client.traffic.droppedOutbound,
      hostMigrations: this.hostMigrations,
      lastMigrationReason: this.lastMigrationReason,
      quarantined: this.quarantinedCount,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/** One sample of what a delta last carried for an entity. */
interface SentSample {
  x: number;
  y: number;
  rotation: number;
  z: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  variant?: string;
  disabled?: boolean;
  quarantined?: boolean;
}

const sentSample = (entity: RenderEntity): SentSample => ({
  x: entity.x,
  y: entity.y,
  rotation: entity.rotation,
  z: entity.z ?? 0,
  vx: entity.vx,
  vy: entity.vy,
  angularVelocity: entity.angularVelocity,
  variant: entity.variant,
  disabled: entity.disabled,
  quarantined: entity.quarantined,
});

/** Movement below these values is not visible at the 100 ms render delay. */
const POSITION_EPSILON = 0.01;
const ROTATION_EPSILON = 0.005;
const VELOCITY_EPSILON = 0.05;

const movedSince = (before: SentSample, now: RenderEntity): boolean =>
  Math.abs(before.x - now.x) > POSITION_EPSILON ||
  Math.abs(before.y - now.y) > POSITION_EPSILON ||
  Math.abs(before.z - (now.z ?? 0)) > POSITION_EPSILON ||
  Math.abs(before.rotation - now.rotation) > ROTATION_EPSILON ||
  Math.abs(before.vx - now.vx) > VELOCITY_EPSILON ||
  Math.abs(before.vy - now.vy) > VELOCITY_EPSILON ||
  Math.abs(before.angularVelocity - now.angularVelocity) > VELOCITY_EPSILON ||
  before.variant !== now.variant ||
  before.disabled !== now.disabled ||
  before.quarantined !== now.quarantined;
// The processed input sequence is not a reason to send. It rides on the entity
// whenever the entity moves, and the 2 Hz keyframe carries it for a still
// avatar. Sending it alone would put every idle avatar in every delta.

const pickCounters = (traffic: {
  inboundBytes: number;
  outboundBytes: number;
  inboundMessages: number;
  outboundMessages: number;
}) => ({
  inboundBytes: traffic.inboundBytes,
  outboundBytes: traffic.outboundBytes,
  inboundMessages: traffic.inboundMessages,
  outboundMessages: traffic.outboundMessages,
});

export const avatarEntityId = (clientId: string): string => `avatar:${clientId}`;
const clientIdOf = (entityId: string): string => entityId.replace(/^avatar:/, "");

/**
 * Spec 19.3. A delta leaves out the definition id. A client learns the
 * definition from the keyframe or from the durable spawn result, and the id
 * would otherwise repeat for every entity 15 times a second.
 */
const toEntityState = (
  entity: RenderEntity,
  behaviorStateJson: Uint8Array,
  keyframe = true,
): EntityState => ({
  entityId: entity.id,
  position: { x: entity.x, y: entity.y },
  rotation: entity.rotation,
  velocity: { x: entity.vx, y: entity.vy },
  angularVelocity: entity.angularVelocity,
  z: entity.z ?? 0,
  vz: 0,
  lastProcessedInputSequence: entity.lastProcessedInputSequence ?? 0,
  spriteVariant: entity.variant ?? "",
  behaviorStateJson,
  quarantined: entity.quarantined ?? false,
  definitionId: keyframe ? entity.definitionId : "",
  disabled: entity.disabled ?? false,
});

const fromEntityState = (state: EntityState): RenderEntity => ({
  id: state.entityId,
  kind: state.entityId.startsWith("avatar:") ? "avatar" : "item",
  definitionId: state.definitionId,
  x: state.position?.x ?? 0,
  y: state.position?.y ?? 0,
  rotation: state.rotation,
  z: state.z || undefined,
  vx: state.velocity?.x ?? 0,
  vy: state.velocity?.y ?? 0,
  angularVelocity: state.angularVelocity,
  variant: state.spriteVariant || undefined,
  lastProcessedInputSequence: state.lastProcessedInputSequence,
  behaviorState: fromJsonBytes(state.behaviorStateJson),
  quarantined: state.quarantined,
  disabled: state.disabled,
});
