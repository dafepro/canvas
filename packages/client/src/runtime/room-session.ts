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
  type Peer,
} from "@canvas-physics/protocol";
import { AvatarReconciler } from "../net/avatar-reconciler.js";
import { dequantizeTransform, quantizeTransform } from "../net/quantization.js";
import { RoomClient } from "../net/room-client.js";
import type { RoomTransport } from "../net/transport.js";
import {
  WebSocketRoomTransport,
  type RealtimeCredentialProvider,
} from "../net/websocket-transport.js";
import { InterpolationBuffer } from "../render/interpolation-buffer.js";
import { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity, SimulationResponse } from "../simulation/messages.js";
import {
  CanvasConsumerError,
  lifecycleError,
  type CanvasLifecycleSnapshot,
  type CanvasLifecycleState,
} from "./lifecycle.js";

/** One sample of movement intent, from a pointer, a key, or a test. */
export interface InputIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
  /** Addendum A1. True while the player asks for a disabled avatar. */
  disabled?: boolean;
}

const NO_INTENT: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

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

/** Send rates from spec 10.3. */
export interface RoomSessionRates {
  inputHz?: number;
  deltaHz?: number;
  keyframeHz?: number;
  checkpointHz?: number;
  /** Maximum reliable preview moves per second. Defaults to 15. */
  previewHz?: number;
}

export interface RoomSessionOptions {
  /** Product-owned room instance id. The server resolves its canvas template. */
  roomId: string;
  serverUrl: string;
  /** Required when transport is omitted. Called for every WebSocket attempt. */
  credentialProvider?: RealtimeCredentialProvider;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  /** Defaults to a worker driver. A test passes `SimulationDriver.local()`. */
  driver?: SimulationDriver;
  rates?: RoomSessionRates;
  /** Movement intent for the local avatar. Defaults to no movement. */
  intent?: () => InputIntent;
  /** Product-owned placement for participant lifecycle transitions. */
  projectParticipantAvatar?: ParticipantAvatarProjector;
  /** Runs once the room accepts the join, before the send loops start. */
  onJoined?: (
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ) => void | Promise<void>;
  /** Stable application-facing failures; consumers never need to parse strings. */
  onError?: (error: CanvasConsumerError) => void;
}

export type ParticipantStatus = "active" | "inactive" | "disconnected";

export interface ParticipantPresence {
  /** Stable authenticated identity. It survives socket reconnects. */
  readonly participantId: string;
  readonly userId: string;
  readonly displayName: string;
  /** Ephemeral socket identity. Absent after disconnect. */
  readonly connectionId?: string;
  /** Stable physics identity derived from participantId. */
  readonly avatarEntityId: string;
  readonly status: ParticipantStatus;
  readonly isHost: boolean;
  readonly hostEligible: boolean;
}

export interface ParticipantAvatarProjectionContext {
  readonly canvas: CanvasDefinition;
  readonly previousStatus?: ParticipantStatus;
}

export interface ParticipantAvatarProjection {
  /** A discontinuous product-owned placement applied on this transition. */
  readonly position?: Vec2;
}

export type ParticipantAvatarProjector = (
  participant: Readonly<ParticipantPresence>,
  context: Readonly<ParticipantAvatarProjectionContext>,
) => ParticipantAvatarProjection | undefined;

export interface PresenceSnapshot {
  readonly participants: readonly Readonly<ParticipantPresence>[];
}

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

type Observer<T> = (value: T) => void;

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
  private previewTimer?: ReturnType<typeof setTimeout>;
  private pendingPreview?: { entityId: string; transform: Transform };
  private lastPreviewSentAt = Number.NEGATIVE_INFINITY;
  private readonly previewIntervalMs: number;
  private localAvatarId = "";
  private inputSequence = 0;
  private hostEntities: RenderEntity[] = [];
  private localPrediction?: RenderEntity;
  private currentTick = 0;
  private simulationReady = false;
  private latestPeers?: Peer[];
  private readonly participantsById = new Map<string, ParticipantPresence>();
  private latestPresenceSnapshot?: PresenceSnapshot;
  private latestCanonicalSource?: { tick: number; entities: RenderEntity[] };
  private latestCanonicalSnapshot?: CanonicalStateSnapshot;
  private latestBehaviorSnapshot?: BehaviorStateSnapshot;
  private readonly presenceObservers = new Set<Observer<PresenceSnapshot>>();
  private readonly canonicalObservers = new Set<Observer<CanonicalStateSnapshot>>();
  private readonly behaviorObservers = new Set<Observer<BehaviorStateSnapshot>>();
  private readonly effectObservers = new Set<Observer<Readonly<EffectEmission>>>();
  private readonly hostAvatarIds = new Set<string>();
  private readonly appliedParticipantStatus = new Map<string, ParticipantStatus>();
  private readonly lastCanonicalAvatarPositions = new Map<string, Vec2>();
  private finalCheckpointSent?: () => void;
  private terminated = false;
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
  private lifecycle: CanvasLifecycleState = "idle";
  private lifecycleSnapshot: CanvasLifecycleSnapshot = Object.freeze({ state: "idle" });
  private readonly lifecycleObservers = new Set<Observer<CanvasLifecycleSnapshot>>();
  private readonly readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: CanvasConsumerError) => void;
  }>();
  private startPromise?: Promise<void>;
  private terminalError?: CanvasConsumerError;
  private pageVisible = true;
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
    this.previewIntervalMs = 1000 / Math.max(1, options.rates?.previewHz ?? 15);
    if (!options.transport && !options.credentialProvider) {
      throw new Error("RoomSession requires a credentialProvider for WebSocket transport");
    }
    const transport =
      options.transport ??
      new WebSocketRoomTransport({ credentialProvider: options.credentialProvider! });
    this.driver = options.driver ?? SimulationDriver.spawn();
    this.client = new RoomClient({
      transport,
      definitions: options.definitions.map((definition) => ({
        definitionId: definition.definitionId,
        version: definition.version,
      })),
      join: {
        roomId: options.roomId,
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

  get userId(): string {
    return this.client.userId;
  }

  get displayName(): string {
    return this.client.displayName;
  }

  subscribePresence(observer: Observer<PresenceSnapshot>): () => void {
    this.presenceObservers.add(observer);
    if (this.latestPresenceSnapshot) observer(this.latestPresenceSnapshot);
    return () => this.presenceObservers.delete(observer);
  }

  subscribeCanonicalState(observer: Observer<CanonicalStateSnapshot>): () => void {
    this.canonicalObservers.add(observer);
    if (this.latestCanonicalSource) this.refreshCanonicalSnapshots();
    if (this.latestCanonicalSnapshot) observer(this.latestCanonicalSnapshot);
    return () => this.canonicalObservers.delete(observer);
  }

  subscribeBehaviorState(observer: Observer<BehaviorStateSnapshot>): () => void {
    this.behaviorObservers.add(observer);
    if (this.latestCanonicalSource) this.refreshCanonicalSnapshots();
    if (this.latestBehaviorSnapshot) observer(this.latestBehaviorSnapshot);
    return () => this.behaviorObservers.delete(observer);
  }

  subscribeEffects(observer: Observer<Readonly<EffectEmission>>): () => void {
    this.effectObservers.add(observer);
    return () => this.effectObservers.delete(observer);
  }

  get lifecycleState(): CanvasLifecycleState {
    return this.lifecycle;
  }

  subscribeLifecycle(observer: Observer<CanvasLifecycleSnapshot>): () => void {
    this.lifecycleObservers.add(observer);
    observer(this.lifecycleSnapshot);
    return () => this.lifecycleObservers.delete(observer);
  }

  /** Resolves after JOIN and consumer initialization (including scene mount). */
  whenReady(): Promise<void> {
    if (this.lifecycle === "active" || this.lifecycle === "backgrounded") {
      return Promise.resolve();
    }
    if (this.lifecycle === "failed" || this.lifecycle === "stopping" ||
        this.lifecycle === "stopped") {
      return Promise.reject(
        this.terminalError ?? lifecycleError(
          "invalid_lifecycle_state",
          `Room session cannot become ready after it is ${this.lifecycle}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  /** Opens the transport and sends JOIN. Use whenReady() to await initialization. */
  start(): Promise<void> {
    if (this.lifecycle === "failed" || this.lifecycle === "stopped" ||
        this.lifecycle === "stopping") {
      return Promise.reject(lifecycleError(
        "invalid_lifecycle_state",
        `Room session is single-use and cannot start after it is ${this.lifecycle}`,
      ));
    }
    if (this.startPromise) return this.startPromise;

    this.running = true;
    this.transition("starting");
    const operation = this.client.connect().then(() => {
      if (this.lifecycle === "stopping" || this.lifecycle === "stopped") {
        throw lifecycleError(
          "start_cancelled",
          "Room session start was cancelled by stop",
        );
      }
      if (this.lifecycle === "starting") this.transition("joining");
    }).catch((cause: unknown) => {
      if (cause instanceof CanvasConsumerError && cause.code === "start_cancelled") {
        throw cause;
      }
      if (this.lifecycle === "stopping" || this.lifecycle === "stopped") {
        throw lifecycleError(
          "start_cancelled",
          "Room session start was cancelled by stop",
          { cause },
        );
      }
      const error = lifecycleError(
        "transport_connection_failed",
        cause instanceof Error ? cause.message : "Room transport failed to connect",
        { source: "transport", cause },
      );
      this.fail(error);
      throw error;
    });
    this.startPromise = operation;
    return operation;
  }

  stop(): void {
    if (this.lifecycle === "failed" || this.lifecycle === "stopping" ||
        this.lifecycle === "stopped") return;
    this.running = false;
    this.transition("stopping");
    this.clearTimers();
    this.finishStop();
  }

  /**
   * Produces a behavior-normalized final checkpoint when this is known to be
   * the room's last client. A timeout falls back to an abrupt close, whose
   * periodic checkpoint remains explicitly unnormalized on the server.
   */
  async stopGracefully(timeoutMs = 250): Promise<void> {
    if (this.lifecycle === "failed" || this.lifecycle === "stopping" ||
        this.lifecycle === "stopped") return;
    const isLastHost =
      this.running &&
      this.simulationReady &&
      this.client.isHost &&
      this.client.peers.length === 1 &&
      this.client.peers[0]?.clientId === this.client.clientId;
    if (!isLastHost) {
      this.stop();
      return;
    }

    this.running = false;
    this.transition("stopping");
    this.clearTimers();
    const sent = new Promise<void>((resolve) => {
      this.finalCheckpointSent = resolve;
    });
    this.driver.send({
      type: "requestSnapshot",
      final: true,
      sceneRevision: this.client.sceneRevision,
      hostEpoch: this.client.hostEpoch,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sent,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.finalCheckpointSent = undefined;
    this.finishStop();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.pendingPreview = undefined;
  }

  private finishStop(): void {
    this.terminateResources();
    this.transition("stopped");
    this.lifecycleObservers.clear();
  }

  private terminateResources(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.finalCheckpointSent?.();
    this.finalCheckpointSent = undefined;
    this.driver.terminate();
    this.client.close();
    this.presenceObservers.clear();
    this.canonicalObservers.clear();
    this.behaviorObservers.clear();
    this.effectObservers.clear();
  }

  private transition(state: CanvasLifecycleState, detail?: string): void {
    if (this.lifecycle === state && this.lifecycleSnapshot.detail === detail) return;
    const previousState = this.lifecycle;
    this.lifecycle = state;
    this.lifecycleSnapshot = Object.freeze({ state, previousState, detail });
    for (const observer of this.lifecycleObservers) observer(this.lifecycleSnapshot);

    if (state === "active" || state === "backgrounded") {
      for (const waiter of this.readyWaiters) waiter.resolve();
      this.readyWaiters.clear();
    } else if (state === "failed" || state === "stopped") {
      const error = this.terminalError ?? lifecycleError(
        "invalid_lifecycle_state",
        `Room session cannot become ready after it is ${state}`,
      );
      for (const waiter of this.readyWaiters) waiter.reject(error);
      this.readyWaiters.clear();
    }
  }

  private reportError(error: CanvasConsumerError): void {
    this.lastRejection = error.message;
    try {
      this.options.onError?.(error);
    } catch {
      // A consumer callback must not prevent terminal resource cleanup or
      // replace the typed error rejected by start()/whenReady().
    }
  }

  private fail(error: CanvasConsumerError): void {
    if (this.lifecycle === "failed" || this.lifecycle === "stopped") return;
    this.running = false;
    this.terminalError = error;
    this.clearTimers();
    this.transition("failed", error.message);
    this.terminateResources();
    this.reportError(error);
  }

  private isTerminalOrStopping(): boolean {
    return this.lifecycle === "stopping" || this.lifecycle === "stopped" ||
      this.lifecycle === "failed";
  }

  // ---------- coordination ----------

  private wireClient(): void {
    this.client.on("joined", (result) => {
      void this.acceptJoin(result.canvas, result.snapshot, result.roomWasSleeping);
    });

    this.client.on("status", (status, detail) => {
      if (this.lifecycle === "stopping" || this.lifecycle === "stopped" ||
          this.lifecycle === "failed") return;
      switch (status) {
        case "connecting":
          if (this.lifecycle === "idle") this.transition("starting", detail);
          break;
        case "open":
          this.transition("joining", detail);
          break;
        case "reconnecting":
          this.transition("reconnecting", detail);
          break;
        case "failed":
          this.fail(lifecycleError(
            "transport_reconnect_exhausted",
            detail || "Room transport exhausted its reconnect attempts",
            { source: "transport" },
          ));
          break;
        case "closed":
          this.fail(lifecycleError(
            "transport_closed",
            detail || "Room transport closed unexpectedly",
            { source: "transport" },
          ));
          break;
        case "idle":
          break;
      }
    });

    this.client.on("hostGranted", (_epoch, snapshot) => {
      this.buffer.reset();
      this.reconciler.reset();
      this.driver.send({
        type: "setHost",
        isHost: true,
        snapshot,
        wakeFromSleep: false,
      });
      // Rebuilding the world drops the local avatar, so add it again.
      this.hostAvatarIds.clear();
      this.appliedParticipantStatus.clear();
      this.spawnLocalAvatar();
      if (this.localAvatarId) this.hostAvatarIds.add(this.localAvatarId);
      this.syncHostAvatars();
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
        this.hostAvatarIds.clear();
        this.appliedParticipantStatus.clear();
        this.spawnLocalAvatar();
      }
    });

    this.client.on("fullState", (state, _epoch, tick) => {
      if (this.client.isHost) return;
      const avatars = new Map(state.avatars.map((avatar) => [avatar.entityId, avatar]));
      const entities = state.entities.map((serialized) => {
        const entity = fromEntityState(serialized);
        const avatar = avatars.get(entity.id);
        return avatar ? { ...entity, userId: avatar.userId } : entity;
      });
      this.rememberFullAvatarState(entities);
      this.buffer.push(tick, entities);
      this.publishCanonicalState(tick, entities);
      this.syncCountdowns(entities, tick);
      this.itemCount = entities.filter((entity) => entity.kind === "item").length;
    });

    this.client.on("stateDelta", (delta, _epoch, tick) => {
      if (this.client.isHost) return;
      const entities = delta.entities.map(fromEntityState);
      this.rememberAvatarDelta(entities, delta.removedEntityIds);
      this.buffer.pushDelta(tick, entities, delta.removedEntityIds);
      this.publishCanonicalState(tick, this.buffer.latest());
      this.syncCountdowns(entities, tick);
    });

    this.client.on("effect", (event) => {
      if (event.effect === "countdown") {
        if (event.mode === "start") this.countdowns.add(event.entityId);
        if (event.mode === "stop") this.countdowns.delete(event.entityId);
      }
      this.publishEffect({
        tick: this.currentTick,
        entityId: event.entityId,
        effect: event.effect,
        mode: (event.mode as "oneShot" | "start" | "stop") || "oneShot",
        params: fromJsonBytes<Record<string, number | string | boolean>>(event.paramsJson),
      });
    });

    this.client.on("playerInput", (input, fromClientId) => {
      if (!this.client.isHost) return;
      const participant = this.latestPeers?.find(
        (candidate) => candidate.clientId === fromClientId,
      );
      if (!participant) return;
      this.driver.send({
        type: "input",
        entityId: avatarEntityId(participant.userId),
        direction: input.direction ?? { x: 0, y: 0 },
        intensity: input.intensity,
        inputSequence: input.inputSequence,
        disabled: input.avatarDisabled,
      });
      if (
        this.setParticipantStatus(
          participant.userId,
          input.avatarDisabled ? "inactive" : "active",
        )
      ) {
        this.publishParticipantSnapshot();
        this.syncHostAvatars();
      }
    });

    this.client.on("presence", (peers) => {
      this.latestPeers = peers;
      this.publishPresence(peers);
      this.syncHostAvatars();
    });

    this.client.on("durableAccepted", (command, _revision, itemJson) => {
      this.applyAcceptedCommand(command, itemJson as SnapshotItem | undefined);
    });

    this.client.on("durablePreview", (command) => {
      if (!this.client.isHost) return;
      this.applyAcceptedCommand(command);
    });

    this.client.on("durableRejected", (_command, reason) => {
      this.reportError(lifecycleError(
        "durable_command_rejected",
        reason,
        { source: "durable-command", recoverable: true },
      ));
    });

    this.client.on("error", (code, message) => {
      this.fail(lifecycleError(
        "server_rejected",
        `${code}: ${message}`,
        { source: "protocol", details: { serverCode: code } },
      ));
    });
  }

  private publishPresence(peers: Peer[]): void {
    const connectedIds = new Set(peers.map((peer) => peer.userId));
    for (const [participantId, participant] of this.participantsById) {
      if (connectedIds.has(participantId)) continue;
      this.participantsById.set(participantId, {
        ...participant,
        connectionId: undefined,
        status: "disconnected",
        isHost: false,
        hostEligible: false,
      });
    }
    for (const peer of peers) {
      const current = this.participantsById.get(peer.userId);
      this.participantsById.set(peer.userId, {
        participantId: peer.userId,
        userId: peer.userId,
        displayName: peer.displayName,
        connectionId: peer.clientId,
        avatarEntityId: avatarEntityId(peer.userId),
        status:
          current?.connectionId === peer.clientId && current.status === "inactive"
            ? "inactive"
            : "active",
        isHost: peer.isHost,
        hostEligible: peer.hostEligible,
      });
    }
    this.publishParticipantSnapshot();
  }

  private publishParticipantSnapshot(): void {
    const participants = Object.freeze(
      [...this.participantsById.values()]
        .sort((a, b) => a.participantId.localeCompare(b.participantId))
        .map((participant) => Object.freeze({ ...participant })),
    );
    const snapshot = Object.freeze({ participants });
    this.latestPresenceSnapshot = snapshot;
    for (const observer of this.presenceObservers) observer(snapshot);
  }

  private setParticipantStatus(
    participantId: string,
    status: ParticipantStatus,
  ): boolean {
    const participant = this.participantsById.get(participantId);
    if (!participant || participant.status === "disconnected" || participant.status === status) {
      return false;
    }
    this.participantsById.set(participantId, { ...participant, status });
    return true;
  }

  private updateParticipantActivity(entities: RenderEntity[]): void {
    let changed = false;
    for (const entity of entities) {
      if (entity.kind !== "avatar" || !entity.userId) continue;
      changed =
        this.setParticipantStatus(
          entity.userId,
          entity.disabled ? "inactive" : "active",
        ) || changed;
    }
    if (changed) this.publishParticipantSnapshot();
  }

  private publishCanonicalState(tick: number, source: RenderEntity[]): void {
    this.updateParticipantActivity(source);
    this.latestCanonicalSource = { tick, entities: source };
    if (this.canonicalObservers.size === 0 && this.behaviorObservers.size === 0) return;
    this.refreshCanonicalSnapshots();
    const snapshot = this.latestCanonicalSnapshot!;
    const behaviorSnapshot = this.latestBehaviorSnapshot!;
    for (const observer of this.canonicalObservers) observer(snapshot);
    for (const observer of this.behaviorObservers) observer(behaviorSnapshot);
  }

  private refreshCanonicalSnapshots(): void {
    const source = this.latestCanonicalSource;
    if (!source) return;
    const entities = Object.freeze(
      source.entities.map((entity) =>
        Object.freeze({
          ...entity,
          behaviorState: immutableValue(entity.behaviorState),
        }),
      ),
    );
    const snapshot = Object.freeze({
      tick: source.tick,
      sceneRevision: this.client.sceneRevision,
      entities,
    });
    this.latestCanonicalSnapshot = snapshot;

    const states = Object.freeze(
      entities
        .filter((entity) => entity.behaviorState !== undefined)
        .map((entity) =>
          Object.freeze({ entityId: entity.id, state: entity.behaviorState }),
        ),
    );
    const behaviorSnapshot = Object.freeze({ tick: source.tick, states });
    this.latestBehaviorSnapshot = behaviorSnapshot;
  }

  private publishEffect(emission: EffectEmission): void {
    const effect = Object.freeze({
      ...emission,
      params: immutableValue(emission.params),
    }) as Readonly<EffectEmission>;
    for (const observer of this.effectObservers) observer(effect);
  }

  private spawnPosition(): Vec2 {
    const spawn = this.canvasDefinition?.spawnPoints[0]?.position;
    if (spawn) {
      // Spread avatars a little so they do not stack on one point.
      return { x: spawn.x + (Math.random() - 0.5) * 6, y: spawn.y };
    }
    return { x: 10, y: 10 };
  }

  private async acceptJoin(
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ): Promise<void> {
    if (this.isTerminalOrStopping()) return;
    try {
      await this.onJoined(canvas, snapshot, wasSleeping);
      if (this.isTerminalOrStopping()) return;
      this.transition(this.pageVisible ? "active" : "backgrounded");
    } catch (cause) {
      this.fail(lifecycleError(
        "join_initialization_failed",
        cause instanceof Error ? cause.message : "Room initialization failed",
        { source: "initialization", cause },
      ));
    }
  }

  private async onJoined(
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ): Promise<void> {
    const nextAvatarId = avatarEntityId(this.client.userId);
    if (this.canvasDefinition) {
      if (this.localAvatarId !== nextAvatarId) {
        if (this.localAvatarId) {
          this.driver.send({ type: "removeAvatar", entityId: this.localAvatarId });
        }
        this.localAvatarId = nextAvatarId;
        this.spawnLocalAvatar();
      }
      return;
    }
    this.canvasDefinition = canvas;
    this.localAvatarId = nextAvatarId;
    this.itemCount = snapshot.items.length;

    await this.options.onJoined?.(canvas, snapshot, wasSleeping);

    this.driver.send({
      type: "init",
      canvas,
      definitions: this.options.definitions,
      tickRate: this.client.tickRate,
      isHost: this.client.isHost,
      snapshot: this.client.isHost ? snapshot : undefined,
      wakeFromSleep: wasSleeping,
      localAvatar: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.client.userId,
        position: this.avatarSpawnPosition(this.localAvatarId),
      },
    });

    this.hostAvatarIds.clear();
    if (this.client.isHost) this.hostAvatarIds.add(this.localAvatarId);

    this.startSendLoops();
  }

  private spawnLocalAvatar(): void {
    if (!this.localAvatarId) return;
    this.driver.send({
      type: "addAvatar",
      spawn: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.client.userId,
        position: this.avatarSpawnPosition(this.localAvatarId),
      },
    });
  }

  private avatarSpawnPosition(entityId: string): Vec2 {
    const canonical = this.lastCanonicalAvatarPositions.get(entityId);
    return canonical ? { ...canonical } : this.spawnPosition();
  }

  private rememberFullAvatarState(entities: RenderEntity[]): void {
    this.lastCanonicalAvatarPositions.clear();
    for (const entity of entities) {
      if (entity.kind !== "avatar") continue;
      this.lastCanonicalAvatarPositions.set(entity.id, { x: entity.x, y: entity.y });
    }
  }

  private rememberAvatarDelta(entities: RenderEntity[], removed: string[]): void {
    for (const entity of entities) {
      if (entity.kind !== "avatar") continue;
      this.lastCanonicalAvatarPositions.set(entity.id, { x: entity.x, y: entity.y });
    }
    for (const entityId of removed) this.lastCanonicalAvatarPositions.delete(entityId);
  }

  /** Keeps the host simulation's transient avatars identical to presence. */
  private syncHostAvatars(): void {
    if (!this.client.isHost || !this.simulationReady || !this.latestPeers) return;
    const desired = new Map(
      [...this.participantsById.values()].map((participant) => [
        participant.avatarEntityId,
        participant,
      ]),
    );

    for (const [entityId, participant] of desired) {
      const previousStatus = this.appliedParticipantStatus.get(entityId);
      const projection = previousStatus === participant.status
        ? undefined
        : this.options.projectParticipantAvatar?.(
            Object.freeze({ ...participant }),
            Object.freeze({ canvas: this.canvasDefinition!, previousStatus }),
          );
      if (!this.hostAvatarIds.has(entityId)) {
        this.driver.send({
          type: "addAvatar",
          spawn: {
            entityId,
            clientId: participant.connectionId ?? "",
            userId: participant.userId,
            position: projection?.position ?? this.avatarSpawnPosition(entityId),
          },
        });
        this.hostAvatarIds.add(entityId);
      }
      if (previousStatus !== participant.status) {
        this.driver.send({
          type: "setAvatarLifecycle",
          entityId,
          disabled: participant.status !== "active",
          ...(projection?.position ? { position: projection.position } : {}),
        });
        this.appliedParticipantStatus.set(entityId, participant.status);
      }
    }
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
    if (
      this.setParticipantStatus(
        this.client.userId,
        disabled ? "inactive" : "active",
      )
    ) {
      this.publishParticipantSnapshot();
      this.syncHostAvatars();
    }
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
              clientId:
                this.participantsById.get(entity.userId ?? "")?.connectionId ?? "",
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
    this.driver.send({
      type: "requestSnapshot",
      final: false,
      sceneRevision: this.client.sceneRevision,
      hostEpoch: this.client.hostEpoch,
    });
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
        this.publishEffect({
          tick,
          entityId: entity.id,
          effect: "countdown",
          mode: "start",
          params: { seconds: remainingTicks / this.client.tickRate },
        });
      } else if (!arming && shown) {
        this.countdowns.delete(entity.id);
        this.publishEffect({
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
    this.pageVisible = visible;
    this.client.health.pageVisible = visible;
    if (!visible && this.client.isHost) this.client.yieldHost("page_hidden");
    this.client.setHostEligible(visible);
    if (!visible && this.lifecycle === "active") {
      this.transition("backgrounded");
    } else if (visible && this.lifecycle === "backgrounded") {
      this.transition("active");
    }
  }

  // ---------- simulation messages ----------

  private onSimulation(message: SimulationResponse): void {
    switch (message.type) {
      case "ready":
        this.simulationReady = true;
        this.syncHostAvatars();
        break;
      case "render": {
        this.currentTick = message.tick;
        this.stats = { ...message.stats };
        this.client.health.simulationHz = message.stats.hz;
        this.client.health.workerDriftMs = message.stats.driftMs;
        if (this.client.isHost) {
          this.hostEntities = message.entities;
          this.publishCanonicalState(message.tick, message.entities);
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
          this.publishEffect(effect);
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
        if (message.final) {
          this.finalCheckpointSent?.();
          this.finalCheckpointSent = undefined;
        }
        break;
      case "error":
        this.reportError(lifecycleError(
          "simulation_failed",
          message.message,
          { source: "simulation", recoverable: true },
        ));
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
    if (preview) {
      this.queuePreview(entityId, transform);
      return;
    }
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.pendingPreview = undefined;
    this.sendMoveItem(entityId, transform, false);
  }

  private queuePreview(entityId: string, transform: Transform): void {
    const now = Date.now();
    const remaining = this.previewIntervalMs - (now - this.lastPreviewSentAt);
    if (remaining <= 0) {
      this.lastPreviewSentAt = now;
      this.sendMoveItem(entityId, transform, true);
      return;
    }
    this.pendingPreview = { entityId, transform };
    if (this.previewTimer) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      const pending = this.pendingPreview;
      this.pendingPreview = undefined;
      if (!pending) return;
      this.lastPreviewSentAt = Date.now();
      this.sendMoveItem(pending.entityId, pending.transform, true);
    }, remaining);
  }

  private sendMoveItem(entityId: string, transform: Transform, preview: boolean): void {
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

  rotateItem(entityId: string, rotation: number): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_ROTATE_ITEM,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: undefined,
      rotation,
      z: 0,
      configJson: new Uint8Array(),
      preview: false,
    });
  }

  setItemConfig(entityId: string, config: unknown): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_SET_CONFIG,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: undefined,
      rotation: 0,
      z: 0,
      configJson: toJsonBytes(config),
      preview: false,
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
            canvasId: this.canvasDefinition?.id ?? "",
            definitionId: command.definitionId,
            definitionVersion: command.definitionVersion,
            // The server owns the record, so its item wins over the command.
            ownerUserId: item?.ownerUserId ?? this.client.userId,
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
      case DurableCommandKind.DURABLE_ROTATE_ITEM: {
        const transform =
          item?.transform ??
          (command.kind === DurableCommandKind.DURABLE_MOVE_ITEM
            ? {
                x: command.position?.x ?? 0,
                y: command.position?.y ?? 0,
                rotation: command.rotation,
                z: command.z || undefined,
              }
            : undefined);
        if (!transform) break;
        this.driver.send({
          type: "moveItem",
          entityId: command.entityId,
          transform,
          preview: command.preview,
        });
        break;
      }
      case DurableCommandKind.DURABLE_SET_CONFIG: {
        const config = item?.resolvedConfig ?? fromJsonBytes(command.configJson);
        if (config === undefined) break;
        this.driver.send({ type: "setItemConfig", entityId: command.entityId, config });
        break;
      }
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
  animation?: string;
  animationEpoch?: number;
  disabled?: boolean;
  quarantined?: boolean;
  teleportEpoch?: number;
  respawning?: boolean;
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
  animation: entity.animation,
  animationEpoch: entity.animationEpoch,
  disabled: entity.disabled,
  quarantined: entity.quarantined,
  teleportEpoch: entity.teleportEpoch,
  respawning: entity.respawning,
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
  before.animation !== now.animation ||
  before.animationEpoch !== now.animationEpoch ||
  before.disabled !== now.disabled ||
  before.quarantined !== now.quarantined ||
  // Addendum A2 and A3. A jump and a respawn must reach every peer on the tick
  // they happen, or a peer slides the sprite across the canvas instead.
  before.teleportEpoch !== now.teleportEpoch ||
  before.respawning !== now.respawning;
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

export const avatarEntityId = (participantId: string): string =>
  `avatar:${participantId}`;

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
  quantizedTransform: quantizeTransform({
    x: entity.x,
    y: entity.y,
    rotation: entity.rotation,
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
  };
};
