import {
  validateCanvasDefinition,
  validateItemDefinition,
  validateSnapshot,
  type CanvasDefinition,
  type CanvasSnapshot,
  type EffectEmission,
  type ItemDefinition,
  type SnapshotItem,
  type Transform,
  type Vec2,
} from "@canvas-physics/core";
import {
  fromJsonBytes,
  toJsonBytes,
} from "@canvas-physics/protocol";
import { RoomClient } from "../net/room-client.js";
import type { RoomTransport } from "../net/transport.js";
import {
  WebSocketRoomTransport,
  type RealtimeCredentialProvider,
} from "../net/websocket-transport.js";
import { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity, SimulationResponse } from "../simulation/messages.js";
import {
  CanvasConsumerError,
  lifecycleError,
  type CanvasLifecycleSnapshot,
  type CanvasLifecycleState,
} from "./lifecycle.js";
import {
  ItemMutationSession,
  type ItemMutationEffect,
  type ItemEditHandle,
  type ItemMutationReceipt,
  type ItemMutationSnapshot,
} from "./session/item-mutation-session.js";
import {
  ReplicationTimeline,
  type BehaviorStateSnapshot,
  type CanonicalStateSnapshot,
} from "./session/replication-timeline.js";
import {
  ParticipantRoster,
  type ParticipantAvatarProjection,
  type ParticipantAvatarProjectionContext,
  type ParticipantAvatarProjector,
  type ParticipantPresence,
  type ParticipantStatus,
  type PresenceSnapshot,
} from "./session/participant-roster.js";
import { PresentationGate } from "./session/presentation-gate.js";
import {
  HostRoleSession,
  type HostRoleEffect,
} from "./session/host-role-session.js";
import {
  ConnectionSession,
  type ConnectionEffect,
  type ConnectionJoin,
} from "./session/connection-session.js";
import {
  StartupProgress,
  type RuntimeStartupObserver,
  type RuntimeStartupSnapshot,
} from "./startup-progress.js";
import {
  ObserverSet,
  type Observer,
  type SubscriptionOptions,
} from "./observers.js";

export type {
  BehaviorStateSnapshot,
  CanonicalStateSnapshot,
} from "./session/replication-timeline.js";
export type {
  ParticipantAvatarProjection,
  ParticipantAvatarProjectionContext,
  ParticipantAvatarProjector,
  ParticipantPresence,
  ParticipantStatus,
  PresenceSnapshot,
} from "./session/participant-roster.js";

/** One sample of movement intent, from a pointer, a key, or a test. */
export interface InputIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
  /** Absolute world target for collision-safe direct avatar dragging. */
  target?: Vec2;
  /** Addendum A1. True while the player asks for a disabled avatar. */
  disabled?: boolean;
}

const NO_INTENT: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

const formatProblems = (
  problems: readonly { path: string; message: string }[],
): string => problems.map(({ path, message }) => `${path} ${message}`).join("; ");

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
  /** Named room spawn used for this session, such as a linked-room arrival. */
  spawnPointId?: string;
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

export type RoomSessionStartBoundary = "connected" | "initialized" | "presented";

export interface RoomSessionStartOptions {
  /** Defaults to `connected` for compatibility with the original start contract. */
  readonly until?: RoomSessionStartBoundary;
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
  inputSequence: number;
  acknowledgedInputSequence: number;
  predictionHistoryDepth: number;
  predictedAvatar?: Readonly<Vec2>;
  canonicalAvatar?: Readonly<Vec2>;
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
  /** Worker messages ignored because they belong to an obsolete role generation. */
  staleSimulationResponses: number;
}

/**
 * Coordination, simulation, and the send rates of spec 10.3, with no renderer
 * and no DOM. `CanvasRuntime` adds the renderer and the input controllers on
 * top of one session.
 */
export class RoomSession {
  readonly client: RoomClient;
  readonly driver: SimulationDriver;
  private canvasDefinition?: CanvasDefinition;
  private readonly mutations: ItemMutationSession;
  private readonly timeline: ReplicationTimeline;
  private readonly roster: ParticipantRoster;
  private readonly presentation = new PresentationGate();
  private readonly startup: StartupProgress;
  private readonly hostRole: HostRoleSession;
  private readonly connection: ConnectionSession;
  private localAvatarId = "";
  private inputSequence = 0;
  private readonly effectObservers: ObserverSet<Readonly<EffectEmission>>;
  private readonly errorObservers: ObserverSet<CanvasConsumerError>;
  private stats = {
    hz: 0,
    driftMs: 0,
    worstStepMs: 0,
    awakeBodies: 0,
    behaviorErrors: 0,
    activeColliders: 0,
  };
  private lastRejection?: string;
  private readonly countdowns = new Set<string>();
  private readonly boundedStartPromises = new Map<RoomSessionStartBoundary, Promise<void>>();
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
    if (!options.transport && !options.credentialProvider) {
      throw new Error("RoomSession requires a credentialProvider for WebSocket transport");
    }
    const transport =
      options.transport ??
      new WebSocketRoomTransport({ credentialProvider: options.credentialProvider! });
    this.errorObservers = new ObserverSet();
    this.effectObservers = new ObserverSet(
      (cause) => this.reportObserverFailure("effects", cause),
    );
    this.startup = new StartupProgress(
      "credentials",
      () => Date.now(),
      (cause) => this.reportObserverFailure("startup", cause),
    );
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
    this.hostRole = new HostRoleSession({
      rates: options.rates,
      sceneRevision: () => this.client.durableRevision.sceneRevision,
      emit: (effect) => this.applyHostRoleEffect(effect),
    });
    this.mutations = new ItemMutationSession({
      definitions: options.definitions,
      previewHz: options.rates?.previewHz,
      context: () => ({
        clientId: this.client.connectionIdentity.clientId,
        userId: this.client.connectionIdentity.userId,
        sceneRevision: this.client.durableRevision.sceneRevision,
        isHost: this.hostRole.isHost,
        canvas: this.canvasDefinition,
      }),
      emit: (effect) => this.applyItemMutationEffect(effect),
      onObserverError: (cause) => this.reportObserverFailure("itemMutations", cause),
    });
    this.roster = new ParticipantRoster({
      projectAvatar: options.projectParticipantAvatar,
      onObserverError: (cause) => this.reportObserverFailure("presence", cause),
    });
    this.timeline = new ReplicationTimeline({
      sceneRevision: () => this.client.durableRevision.sceneRevision,
      decorate: (entity) => this.mutations.decorate(entity),
      onCanonical: (tick, entities) => {
        const canonical = [...entities];
        this.mutations.observeCanonical(this.client.durableRevision.sceneRevision, canonical);
        this.roster.observeCanonical(canonical);
        this.syncCountdowns(canonical, tick);
        this.presentation.markCanonical(
          this.connection.generation,
          canonical.map((entity) => entity.id),
        );
      },
      onCanonicalObserverError: (cause) => this.reportObserverFailure("canonicalState", cause),
      onBehaviorObserverError: (cause) => this.reportObserverFailure("behaviorState", cause),
    });
    this.connection = new ConnectionSession({
      validateJoin: (canvas, snapshot) => this.validateJoinPayload(canvas, snapshot),
      initializeConsumer: options.onJoined,
      installJoin: (join) => this.installAcceptedJoin(join),
      emit: (effect) => this.applyConnectionEffect(effect),
      onObserverError: (cause) => this.reportObserverFailure("lifecycle", cause),
    });
    this.connection.subscribe((snapshot) => this.observeConnectionStartup(snapshot));
    this.wireClient();
    this.driver.onMessage((message) => this.onSimulation(message));
  }

  get canvas(): CanvasDefinition | undefined {
    return this.canvasDefinition;
  }

  get tick(): number {
    return this.timeline.tick;
  }

  get avatarId(): string {
    return this.localAvatarId;
  }

  get userId(): string {
    return this.client.connectionIdentity.userId;
  }

  get displayName(): string {
    return this.client.connectionIdentity.displayName;
  }

  subscribePresence(observer: Observer<PresenceSnapshot>, options?: SubscriptionOptions): () => void {
    return this.roster.subscribe(observer, options);
  }

  subscribeCanonicalState(
    observer: Observer<CanonicalStateSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.timeline.subscribeCanonical(observer, options);
  }

  subscribeBehaviorState(
    observer: Observer<BehaviorStateSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.timeline.subscribeBehavior(observer, options);
  }

  subscribeEffects(
    observer: Observer<Readonly<EffectEmission>>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.effectObservers.subscribe(observer, options);
  }

  subscribeItemMutations(
    observer: Observer<ItemMutationSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.mutations.subscribeMutations(observer, options);
  }

  get lifecycleState(): CanvasLifecycleState {
    return this.connection.lifecycleState;
  }

  subscribeLifecycle(
    observer: Observer<CanvasLifecycleSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.connection.subscribe(observer, options);
  }

  get startupSnapshot(): Readonly<RuntimeStartupSnapshot> {
    return this.startup.snapshot;
  }

  subscribeStartup(observer: RuntimeStartupObserver, options?: SubscriptionOptions): () => void {
    return this.startup.subscribe(observer, options);
  }

  /** Transient typed runtime failures. Errors are not replayed. */
  subscribeErrors(
    observer: Observer<CanvasConsumerError>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.errorObservers.subscribe(observer, options);
  }

  whenStartupReady(): Promise<void> {
    return this.startup.waitUntilReady();
  }

  /** Resolves after JOIN and consumer initialization (including scene mount). */
  whenReady(): Promise<void> {
    return this.connection.whenReady();
  }

  /** Resolves after the first complete authoritative room frame is available. */
  whenPresented(): Promise<void> {
    if (this.connection.isTerminalOrStopping) {
      return Promise.reject(
        this.connection.terminalError ?? lifecycleError(
          "invalid_lifecycle_state",
          `Room session cannot become presentable after it is ${this.lifecycleState}`,
        ),
      );
    }
    return this.presentation.wait();
  }

  /**
   * Starts the room and optionally waits for a semantic usability boundary.
   * The no-argument form retains the original connected/JOIN-sent contract.
   */
  start(options: RoomSessionStartOptions = {}): Promise<void> {
    const connected = this.connection.start(() => this.client.connect());
    const boundary = options.until ?? "connected";
    if (boundary === "connected") return connected;
    const existing = this.boundedStartPromises.get(boundary);
    if (existing) return existing;
    const operation = connected.then(() => boundary === "initialized"
      ? this.whenReady()
      : this.whenPresented());
    this.boundedStartPromises.set(boundary, operation);
    return operation;
  }

  stop(): void {
    if (!this.connection.beginStop()) return;
    this.finishStop();
  }

  /**
   * Produces a behavior-normalized final checkpoint when this is known to be
   * the room's last client. A timeout falls back to an abrupt close, whose
   * periodic checkpoint remains explicitly unnormalized on the server.
   */
  async stopGracefully(timeoutMs = 250): Promise<void> {
    if (this.connection.isTerminalOrStopping) return;
    const isLastHost =
      this.connection.running &&
      this.hostRole.simulationReady &&
      this.hostRole.isHost &&
      this.client.presence.peers.length === 1 &&
      this.client.presence.peers[0]?.clientId === this.client.connectionIdentity.clientId;
    if (!isLastHost) {
      this.stop();
      return;
    }

    if (!this.connection.beginStop()) return;
    await this.hostRole.requestFinalCheckpoint(
      this.client.durableRevision.sceneRevision,
      timeoutMs,
    );
    this.finishStop();
  }

  private finishStop(): void {
    this.terminateResources();
    this.connection.finishStop();
    this.presentation.fail(lifecycleError(
      "invalid_lifecycle_state",
      "Room session cannot become presentable after it is stopped",
    ));
  }

  private terminateResources(): void {
    if (!this.connection.claimResourceClose()) return;
    this.mutations.destroy();
    this.hostRole.destroy();
    this.driver.terminate();
    this.client.close();
    this.roster.clearObservers();
    this.timeline.clearObservers();
    this.effectObservers.clear();
    this.errorObservers.clear();
  }

  private reportError(error: CanvasConsumerError): void {
    this.lastRejection = error.message;
    try {
      this.options.onError?.(error);
    } catch {
      // A consumer callback must not prevent terminal resource cleanup or
      // replace the typed error rejected by start()/whenReady().
    }
    this.errorObservers.publish(error);
  }

  private reportObserverFailure(stream: string, cause: unknown): void {
    this.reportError(lifecycleError(
      "consumer_callback_failed",
      `A '${stream}' observer threw`,
      {
        source: "consumer",
        recoverable: true,
        cause,
        details: { stream },
      },
    ));
  }

  private handleConnectionFailure(error: CanvasConsumerError): void {
    this.presentation.fail(error);
    this.reportError(error);
    this.terminateResources();
  }

  private isTerminalOrStopping(): boolean {
    return this.connection.isTerminalOrStopping;
  }

  // ---------- coordination ----------

  private wireClient(): void {
    this.client.on("joined", (result) => {
      this.connection.joined(result.canvas, result.snapshot, result.roomWasSleeping);
    });

    this.client.on("status", (status, detail) => {
      if (status === "connecting" || status === "open") {
        // An injected transport may omit the explicit connecting status.
        this.startup.advance("connecting");
      }
      this.connection.transportStatus(status, detail);
    });

    this.client.on("hostGranted", (lease, snapshot, reason) => {
      this.hostRole.grant({ lease, snapshot, reason });
    });

    this.client.on("hostChanged", (lease, reason) => {
      this.hostRole.change({ lease, reason });
    });

    this.client.on("fullState", (state, _epoch, tick) => {
      if (this.hostRole.isHost) return;
      this.timeline.acceptFullState(state, tick);
      this.checkPresentationReady();
    });

    this.client.on("stateDelta", (delta, _epoch, tick) => {
      if (this.hostRole.isHost) return;
      this.timeline.acceptDelta(delta, tick);
      this.checkPresentationReady();
    });

    this.client.on("effect", (event) => {
      if (event.effect === "countdown") {
        if (event.mode === "start") this.countdowns.add(event.entityId);
        if (event.mode === "stop") this.countdowns.delete(event.entityId);
      }
      this.publishEffect({
        tick: this.timeline.tick,
        entityId: event.entityId,
        effect: event.effect,
        mode: (event.mode as "oneShot" | "start" | "stop") || "oneShot",
        params: fromJsonBytes<Record<string, number | string | boolean>>(event.paramsJson),
      });
    });

    this.client.on("playerInput", (input, fromClientId) => {
      if (!this.hostRole.isHost) return;
      const participant = this.roster.peerForConnection(fromClientId);
      if (!participant) return;
      this.driver.send({
        type: "input",
        entityId: avatarEntityId(participant.userId),
        direction: input.direction ?? { x: 0, y: 0 },
        intensity: input.intensity,
        inputSequence: input.inputSequence,
        held: input.held,
        target: input.targetPosition,
        disabled: input.avatarDisabled,
      });
      if (this.roster.setActivity(
        participant.userId,
        input.avatarDisabled ? "inactive" : "active",
      )) this.syncHostAvatars();
    });

    this.client.on("presence", (peers) => {
      this.roster.updatePresence(peers);
      this.presentation.markPresence(
        this.connection.generation,
        this.roster.connectedAvatarIds,
      );
      this.syncHostAvatars();
      this.checkPresentationReady();
    });

    this.client.on("itemMutationResult", (result, itemJson) => {
      this.mutations.acceptMutation(result, itemJson as SnapshotItem | undefined);
      this.checkPresentationReady();
    });

    this.client.on("itemEditPreview", (preview) => {
      this.mutations.acceptPreview(preview);
    });

    this.client.on("itemEditSessionResult", (result, itemJson) => {
      this.mutations.acceptEditSession(result, itemJson as SnapshotItem | undefined);
    });

    this.client.on("error", (code, message) => {
      const recoverable = code === "definition_mismatch";
      const error = lifecycleError(
        "server_rejected",
        `${code}: ${message}`,
        { source: "protocol", recoverable, details: { serverCode: code } },
      );
      if (recoverable) {
        this.reportError(error);
        return;
      }
      this.connection.fail(error);
    });
  }

  private publishEffect(emission: EffectEmission): void {
    const effect = Object.freeze({
      ...emission,
      params: immutableValue(emission.params),
    }) as Readonly<EffectEmission>;
    this.effectObservers.publish(effect);
  }

  private spawnPosition(entityId: string): Vec2 {
    const requested = this.options.spawnPointId;
    const spawnPoint = requested
      ? this.canvasDefinition?.spawnPoints.find((candidate) => candidate.id === requested)
      : this.canvasDefinition?.spawnPoints[0];
    const spawn = spawnPoint?.position;
    if (spawn) {
      // Host and peer prediction must derive exactly the same starting pose.
      // A random local offset makes the peer correct toward a different host
      // spawn on every keyframe, which presents as periodic rubber-banding.
      return { x: spawn.x + stableSpawnOffset(entityId), y: spawn.y };
    }
    return { x: 10, y: 10 };
  }

  private installAcceptedJoin(join: ConnectionJoin): void {
    this.mutations.loadSnapshot(join.snapshot);
    this.mutations.connectionReady();
    this.timeline.resetEpoch(this.hostRole.hostEpoch || this.client.hostLease.epoch);
    this.roster.loadSnapshotPositions(join.snapshot);
    this.presentation.markItems(join.generation, this.mutations.itemEntityIds);
    this.installJoin(join.canvas, join.snapshot, join.wasSleeping);
  }

  private validateJoinPayload(canvas: CanvasDefinition, snapshot: CanvasSnapshot): void {
    const definitionIds = new Set<string>();
    for (const definition of this.options.definitions) {
      if (definitionIds.has(definition.definitionId)) {
        throw new Error(`duplicate item definition '${definition.definitionId}'`);
      }
      definitionIds.add(definition.definitionId);
      const validation = validateItemDefinition(definition);
      if (!validation.ok) {
        throw new Error(
          `invalid item definition '${definition.definitionId}': ` +
          formatProblems(validation.problems),
        );
      }
    }
    const canvasValidation = validateCanvasDefinition(canvas);
    if (!canvasValidation.ok) {
      throw new Error(`invalid canvas definition: ${formatProblems(canvasValidation.problems)}`);
    }
    const snapshotValidation = validateSnapshot(snapshot, canvas);
    if (!snapshotValidation.ok) {
      throw new Error(`invalid canvas snapshot: ${formatProblems(snapshotValidation.problems)}`);
    }
    if (
      this.options.spawnPointId &&
      !canvas.spawnPoints.some((candidate) => candidate.id === this.options.spawnPointId)
    ) {
      throw new Error(
        `canvas '${canvas.id}' has no spawn point '${this.options.spawnPointId}'`,
      );
    }
  }

  private installJoin(
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ): void {
    const nextAvatarId = avatarEntityId(this.client.connectionIdentity.userId);
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

    this.hostRole.initialize({
      lease: this.client.hostLease,
      canvas,
      definitions: this.options.definitions,
      tickRate: this.client.connectionIdentity.tickRate,
      snapshot,
      wakeFromSleep: wasSleeping,
      localAvatar: {
        entityId: this.localAvatarId,
        clientId: this.client.connectionIdentity.clientId,
        userId: this.client.connectionIdentity.userId,
        position: this.avatarSpawnPosition(this.localAvatarId),
      },
    });

    this.startSendLoops();
  }

  private spawnLocalAvatar(): void {
    if (!this.localAvatarId) return;
    this.hostRole.recordAvatarRequest({
      type: "addAvatar",
      spawn: {
        entityId: this.localAvatarId,
        clientId: this.client.connectionIdentity.clientId,
        userId: this.client.connectionIdentity.userId,
        position: this.avatarSpawnPosition(this.localAvatarId),
      },
    });
  }

  private avatarSpawnPosition(entityId: string): Vec2 {
    if (this.options.spawnPointId) return this.spawnPosition(entityId);
    return this.roster.spawnPosition(entityId, () => this.spawnPosition(entityId));
  }

  /** Keeps the host simulation's transient avatars identical to presence. */
  private syncHostAvatars(): void {
    if (
      !this.hostRole.isHost ||
      !this.hostRole.simulationReady ||
      !this.roster.presenceKnown ||
      !this.canvasDefinition
    ) return;
    for (const request of this.roster.reconcileHostAvatars({
      canvas: this.canvasDefinition,
      hostAvatarIds: new Set(this.hostRole.hostAvatarIds),
      spawnPosition: (entityId) => this.avatarSpawnPosition(entityId),
    })) this.hostRole.recordAvatarRequest(request);
  }

  private applyHostRoleEffect(effect: HostRoleEffect): void {
    switch (effect.type) {
      case "simulate":
        this.driver.send(effect.request);
        break;
      case "publishFrame":
        this.sendDelta(effect.keyframe, effect.lease);
        break;
      case "requestCheckpoint":
        this.driver.send({
          type: "requestSnapshot",
          generation: effect.generation,
          final: effect.final,
          sceneRevision: effect.sceneRevision,
          hostEpoch: effect.hostEpoch,
        });
        break;
      case "yieldHost":
        this.client.yieldHost(effect.reason, effect.lease);
        break;
      case "roleRebuilt":
        // Spec 11.2. A role generation cannot retain interpolation,
        // prediction, projection, or readiness facts from the old authority.
        this.timeline.resetEpoch(effect.epoch);
        if (effect.snapshot) {
          // Migration checkpoints may trail a frame already observed locally.
          this.roster.loadSnapshotPositions(effect.snapshot, true);
        }
        this.roster.resetHostProjection();
        this.presentation.resetRole(this.connection.generation);
        this.driver.send(effect.request);
        this.spawnLocalAvatar();
        this.syncHostAvatars();
        break;
    }
  }

  private applyConnectionEffect(effect: ConnectionEffect): void {
    switch (effect.type) {
      case "connectionReset":
        this.presentation.resetConnection(effect.generation);
        if (effect.reason === "reconnecting") this.mutations.resetConnection();
        break;
      case "failed":
        this.handleConnectionFailure(effect.error);
        break;
    }
  }

  // ---------- loops ----------

  private startSendLoops(): void {
    const rates = this.options.rates ?? {};
    const inputHz = rates.inputHz ?? 30;
    this.connection.schedule(() => this.sendInput(), 1000 / inputHz);
  }

  private sendInput(): void {
    const intent = this.options.intent?.() ?? NO_INTENT;
    this.inputSequence++;
    const disabled = intent.disabled === true;
    if (this.roster.setActivity(
      this.client.connectionIdentity.userId,
      disabled ? "inactive" : "active",
    )) this.syncHostAvatars();
    // The host applies its own input directly; a peer sends it through the relay.
    this.driver.send({
      type: "input",
      entityId: this.localAvatarId,
      direction: intent.direction,
      intensity: intent.intensity,
      inputSequence: this.inputSequence,
      held: intent.held,
      target: intent.target,
      disabled,
    });
    if (!this.hostRole.isHost) {
      this.client.sendInput({
        inputSequence: this.inputSequence,
        direction: intent.direction,
        intensity: intent.intensity,
        clientTimeUnixMs: Date.now(),
        held: intent.held,
        avatarDisabled: disabled,
        targetPosition: intent.target,
      });
    }
  }

  private sendDelta(
    keyframe: boolean,
    lease = this.hostRole.hostLease,
  ): void {
    if (!this.hostRole.isHost || this.timeline.hostEntities.length === 0) return;
    const frame = this.timeline.encodeHostFrame(keyframe);
    if (keyframe) {
      this.client.sendFullState(
        {
          entities: frame.entities,
          avatars: this.timeline.hostEntities
            .filter((entity) => entity.kind === "avatar")
            .map((entity) => ({
              entityId: entity.id,
              clientId: this.roster.connectionId(entity.userId ?? "") ?? "",
              userId: entity.userId ?? "",
              displayName: entity.userId ?? "",
            })),
          sceneRevision: this.client.durableRevision.sceneRevision,
          tickRate: this.client.connectionIdentity.tickRate,
        },
        this.timeline.tick,
        lease,
      );
      return;
    }
    if (frame.entities.length === 0 && frame.removedEntityIds.length === 0) return;
    this.client.sendStateDelta(
      {
        entities: frame.entities,
        removedEntityIds: frame.removedEntityIds,
        sceneRevision: this.client.durableRevision.sceneRevision,
      },
      this.timeline.tick,
      lease,
    );
  }

  /**
   * The entities to draw at `nowMs`. The host draws its own world. A peer draws
   * the interpolated remote state plus its reconciled local avatar.
   */
  entitiesToDraw(nowMs: number): RenderEntity[] {
    return this.mutations.present(
      this.timeline.frame(nowMs, this.localAvatarId, this.hostRole.isHost),
    );
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
          params: { seconds: remainingTicks / this.client.connectionIdentity.tickRate },
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
    this.client.health.pageVisible = visible;
    this.connection.setPageVisible(visible);
    this.hostRole.setPageVisible(visible);
    this.client.setHostEligible(visible);
  }

  // ---------- simulation messages ----------

  private onSimulation(message: SimulationResponse): void {
    if (!this.hostRole.acceptSimulation(message)) return;
    switch (message.type) {
      case "ready":
        // A synchronous local driver may report ready before the JOIN
        // transition publishes active, so explicitly preserve both milestones.
        this.startup.advance("simulation");
        this.startup.advance("canonical");
        this.presentation.markSimulationReady(this.connection.generation);
        this.syncHostAvatars();
        this.checkPresentationReady();
        break;
      case "render": {
        this.stats = { ...message.stats };
        this.client.health.simulationHz = message.stats.hz;
        this.client.health.workerDriftMs = message.stats.driftMs;
        if (this.hostRole.isHost) {
          this.timeline.acceptHostFrame(message.tick, message.entities);
          // Spec 22.1. The host is the only client that can quarantine a body.
          this.hostRole.recordHostFrame(
            message.entities.filter((entity) => entity.quarantined).length,
          );
        } else {
          this.timeline.acceptLocalPredictionFrame(
            message.tick,
            message.entities,
            this.localAvatarId,
          );
        }
        this.checkPresentationReady();
        break;
      }
      case "effects":
        for (const effect of message.effects) {
          this.publishEffect(effect);
          if (this.hostRole.isHost) {
            this.client.sendEffect(
              {
                entityId: effect.entityId,
                effect: effect.effect,
                mode: effect.mode,
                paramsJson: effect.params ? toJsonBytes(effect.params) : new Uint8Array(),
              },
              message.tick,
              this.hostRole.hostLease,
            );
          }
        }
        break;
      case "snapshot":
        this.client.sendCheckpoint(
          message.snapshot,
          message.snapshot.checkpointRevision,
          message.final,
          this.hostRole.hostLease,
        );
        this.checkPresentationReady();
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
  spawnItem(
    definitionId: string,
    at: Vec2,
    rotation = 0,
    scale = 1,
  ): ItemMutationReceipt {
    return this.mutations.spawnItem(definitionId, at, rotation, scale);
  }

  private checkPresentationReady(): void {
    const generation = this.connection.generation;
    if (this.hostRole.simulationReady) this.presentation.markSimulationReady(generation);
    if (this.roster.presenceKnown) {
      this.presentation.markPresence(generation, this.roster.connectedAvatarIds);
    }
    this.presentation.markItems(generation, this.mutations.itemEntityIds);
    const authoritative = this.hostRole.isHost
      ? this.timeline.hostEntities
      : this.timeline.latestEntities;
    if (!this.hostRole.isHost && this.timeline.latestPeerTick === undefined) return;
    this.presentation.markCanonical(
      generation,
      authoritative.map((entity) => entity.id),
    );
    if (this.presentation.authoritativeCurrent) {
      this.startup.advance("presenting");
      // A headless session has handed the complete set to its consumer. The
      // browser facade delays its own ready milestone until Pixi updates it.
      this.startup.advance("ready");
    }
  }

  private observeConnectionStartup(snapshot: CanvasLifecycleSnapshot): void {
    switch (snapshot.state) {
      case "joining":
        this.startup.advance("connecting");
        this.startup.advance("joining");
        break;
      case "active":
      case "backgrounded":
        this.startup.advance("simulation");
        break;
      case "failed":
        if (this.connection.terminalError) this.startup.fail(this.connection.terminalError);
        break;
      case "stopping":
      case "stopped":
        this.startup.cancel();
        break;
      case "idle":
      case "starting":
      case "reconnecting":
        break;
    }
  }

  beginItemEdit(entityId: string): ItemEditHandle {
    return this.mutations.beginItemEdit(entityId);
  }

  moveItem(entityId: string, transform: Transform): ItemMutationReceipt {
    return this.mutations.moveItem(entityId, transform);
  }

  rotateItem(entityId: string, rotation: number): ItemMutationReceipt {
    return this.mutations.rotateItem(entityId, rotation);
  }

  scaleItem(entityId: string, scale: number): ItemMutationReceipt {
    return this.mutations.scaleItem(entityId, scale);
  }

  setItemConfig(entityId: string, config: unknown): ItemMutationReceipt {
    return this.mutations.setItemConfig(entityId, config);
  }

  setItemIsolation(entityId: string, isolated: boolean): ItemMutationReceipt {
    return this.mutations.setItemIsolation(entityId, isolated);
  }

  setItemCollisionsEnabled(entityId: string, enabled: boolean): ItemMutationReceipt {
    return this.mutations.setItemCollisionsEnabled(entityId, enabled);
  }

  deleteItem(entityId: string): ItemMutationReceipt {
    return this.mutations.deleteItem(entityId);
  }

  private applyItemMutationEffect(effect: ItemMutationEffect): void {
    switch (effect.type) {
      case "sendMutation":
        this.client.sendItemMutation(effect.mutation);
        break;
      case "beginEdit":
        this.client.beginItemEdit(effect.request);
        break;
      case "renewEdit":
        this.client.renewItemEdit(effect.request);
        break;
      case "endEdit":
        this.client.endItemEdit(effect.request);
        break;
      case "sendPreview":
        this.client.sendItemEditPreview(effect.preview);
        break;
      case "simulate":
        this.driver.send(effect.request);
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
    const timeline = this.timeline.diagnostics;
    const hostRole = this.hostRole.diagnostics;
    const canonicalAvatar = this.timeline.canonicalAvatar(
      this.localAvatarId,
      this.hostRole.isHost,
    );
    return {
      status: this.hostRole.isHost ? "host" : "peer",
      isHost: this.hostRole.isHost,
      hostEpoch: hostRole.hostEpoch,
      hostClientId: this.client.hostLease.hostClientId,
      clientId: this.client.connectionIdentity.clientId,
      peers: this.client.presence.peers.length,
      tick: timeline.tick,
      simulationHz: this.stats.hz,
      driftMs: this.stats.driftMs,
      worstStepMs: this.stats.worstStepMs,
      awakeBodies: this.stats.awakeBodies,
      activeColliders: this.stats.activeColliders,
      interpolationDepth: timeline.interpolationDepth,
      extrapolations: timeline.extrapolations,
      reconcileError: timeline.reconcileError,
      inputSequence: this.inputSequence,
      acknowledgedInputSequence: timeline.acknowledgedInputSequence,
      predictionHistoryDepth: timeline.predictionHistoryDepth,
      predictedAvatar: timeline.predictedAvatar,
      canonicalAvatar: canonicalAvatar
        ? Object.freeze({ x: canonicalAvatar.x, y: canonicalAvatar.y })
        : undefined,
      sceneRevision: this.client.durableRevision.sceneRevision,
      itemCount: this.mutations.itemCount,
      lastRejection: this.lastRejection,
      ...this.trafficRates(),
      droppedOutbound: this.client.traffic.droppedOutbound,
      hostMigrations: hostRole.hostMigrations,
      lastMigrationReason: hostRole.lastMigrationReason,
      quarantined: hostRole.quarantined,
      staleSimulationResponses: hostRole.staleSimulationResponses,
    };
  }

  get isRunning(): boolean {
    return this.connection.running;
  }
}

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

/** Stable ±3-unit spread shared by the host and the predicting peer. */
const stableSpawnOffset = (entityId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < entityId.length; index++) {
    hash ^= entityId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0xffffffff - 0.5) * 6;
};
