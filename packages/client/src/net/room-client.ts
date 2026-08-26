import {
  PROTOCOL_VERSION,
  envelope as newEnvelope,
  fromJsonBytes,
  toJsonBytes,
  HostControlKind,
  type BeginItemEdit,
  type EndItemEdit,
  type FullState,
  type ItemEditPreview,
  type ItemEditSessionResult,
  type ItemMutation,
  type ItemMutationResult,
  type Peer,
  type PlayerInput,
  type RenewItemEdit,
  type RoomEnvelope,
  type StateDelta,
  type EffectEvent,
} from "@canvas-physics/protocol";
import type { CanvasDefinition, CanvasSnapshot } from "@canvas-physics/core";
import type {
  JoinDescriptor,
  RoomTransport,
  TransportStatus,
  TransportTraffic,
} from "./transport.js";

export interface RoomJoinResult {
  roomId: string;
  canvasId: string;
  identity: ConnectionIdentity;
  lease: HostLease;
  revision: DurableRevision;
  canvas: CanvasDefinition;
  snapshot: CanvasSnapshot;
  roomWasSleeping: boolean;
}

export interface ConnectionIdentity {
  readonly generation: number;
  readonly clientId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly tickRate: number;
}

export interface HostLease {
  readonly epoch: number;
  readonly hostClientId: string;
  readonly localClientId: string;
  readonly isHost: boolean;
}

export interface DurableRevision {
  readonly sceneRevision: number;
}

export interface RoomPresence {
  readonly peers: readonly Readonly<Peer>[];
}

export interface RoomClientEvents {
  joined(result: RoomJoinResult): void;
  presence(peers: Peer[]): void;
  /** This client is now the simulation host. */
  hostGranted(lease: HostLease, snapshot: CanvasSnapshot | undefined, reason: string): void;
  /** Another client is the host, or this client lost the lease. */
  hostChanged(lease: HostLease, reason: string): void;
  fullState(state: FullState, epoch: number, tick: number): void;
  stateDelta(delta: StateDelta, epoch: number, tick: number): void;
  effect(event: EffectEvent, tick: number): void;
  playerInput(input: PlayerInput, fromClientId: string): void;
  itemEditPreview(preview: ItemEditPreview, fromClientId: string): void;
  itemEditSessionResult(result: ItemEditSessionResult, itemJson?: unknown): void;
  itemMutationResult(result: ItemMutationResult, itemJson?: unknown): void;
  status(status: TransportStatus, detail?: string): void;
  error(code: string, message: string): void;
}

type Listener<K extends keyof RoomClientEvents> = RoomClientEvents[K];

export interface RoomClientOptions {
  transport: RoomTransport;
  join: JoinDescriptor;
  /** Host heartbeat rate. Spec 10.3 recommends 2 Hz. */
  heartbeatHz?: number;
  /**
   * Spec 20. The item definitions this client holds. The room compares them
   * with the definitions the scene uses and refuses the host lease to a client
   * that lacks one.
   */
  definitions?: { definitionId: string; version: number }[];
}

/**
 * Coordination client. It owns the host lease state and the heartbeat, and it
 * never interprets physics.
 */
export class RoomClient {
  private readonly transport: RoomTransport;
  private readonly joinDescriptor: JoinDescriptor;
  private readonly listeners = new Map<keyof RoomClientEvents, Set<unknown>>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly heartbeatHz: number;

  private identityValue: ConnectionIdentity = Object.freeze({
    generation: 0,
    clientId: "",
    userId: "",
    displayName: "",
    tickRate: 60,
  });
  private leaseValue: HostLease = Object.freeze({
    epoch: 0,
    hostClientId: "",
    localClientId: "",
    isHost: false,
  });
  private revisionValue: DurableRevision = Object.freeze({ sceneRevision: 0 });
  private presenceValue: RoomPresence = Object.freeze({ peers: Object.freeze([]) });
  /** Health values sent with each heartbeat, updated by the runtime. */
  health = { simulationHz: 0, workerDriftMs: 0, pageVisible: true };

  private sequence = 0;
  private readonly definitions: { definitionId: string; version: number }[];

  /** Spec 22.1. The realtime counters of the transport in use. */
  get traffic(): TransportTraffic {
    return this.transport.traffic;
  }

  constructor(options: RoomClientOptions) {
    this.transport = options.transport;
    this.joinDescriptor = options.join;
    this.heartbeatHz = options.heartbeatHz ?? 2;
    this.definitions = options.definitions ?? [];
    this.transport.onMessage((message) => this.receive(message));
    this.transport.onStatus((status, detail) => this.handleTransportStatus(status, detail));
  }

  on<K extends keyof RoomClientEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit<K extends keyof RoomClientEvents>(
    event: K,
    ...args: Parameters<RoomClientEvents[K]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  async connect(): Promise<void> {
    await this.transport.connect(this.joinDescriptor);
    this.startHeartbeat();
  }

  get connectionIdentity(): ConnectionIdentity {
    return this.identityValue;
  }

  get hostLease(): HostLease {
    return this.leaseValue;
  }

  get durableRevision(): DurableRevision {
    return this.revisionValue;
  }

  get presence(): RoomPresence {
    return this.presenceValue;
  }

  private sendJoin(): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        join: {
          roomId: this.joinDescriptor.roomId,
          protocolVersion: PROTOCOL_VERSION,
          definitions: this.definitions,
          pageHidden: !this.health.pageVisible,
        },
      }),
    );
  }

  private handleTransportStatus(status: TransportStatus, detail?: string): void {
    if (status === "reconnecting" || status === "failed") {
      const heldHostRole = this.leaseValue.isHost;
      this.leaseValue = Object.freeze({
        ...this.leaseValue,
        hostClientId: "",
        isHost: false,
      });
      if (heldHostRole) {
        this.emit("hostChanged", this.leaseValue, "transport_lost");
      }
    }
    if (status === "open") {
      // Every WebSocket is a new room connection with a new client id. JOIN is
      // therefore the first application envelope on both initial connect and
      // reconnect.
      this.sendJoin();
    }
    this.emit("status", status, detail);
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.transport.close();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.transport.sendReliable(
        newEnvelope(this.joinDescriptor.roomId, {
          hostEpoch: this.leaseValue.epoch,
          heartbeat: {
            sentAtUnixMs: Date.now(),
            simulationHz: this.health.simulationHz,
            workerDriftMs: this.health.workerDriftMs,
            pageVisible: this.health.pageVisible,
          },
        }),
      );
    }, 1000 / this.heartbeatHz);
  }

  // ---------- sending ----------

  sendInput(input: PlayerInput): void {
    this.transport.sendRealtime(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        sequence: ++this.sequence,
        playerInput: input,
      }),
    );
  }

  /**
   * Spec 11.1. Only the client the room names may publish canonical state.
   * `isHost` alone is not enough: it can survive a reconnect that moved the
   * lease.
   */
  private holdsLease(lease: HostLease): boolean {
    return lease === this.leaseValue &&
      lease.isHost &&
      lease.hostClientId === this.identityValue.clientId;
  }

  sendStateDelta(delta: StateDelta, tick: number, lease: HostLease): void {
    if (!this.holdsLease(lease)) return;
    this.transport.sendRealtime(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        sequence: ++this.sequence,
        tick,
        stateDelta: delta,
      }),
    );
  }

  sendFullState(state: FullState, tick: number, lease: HostLease): void {
    if (!this.holdsLease(lease)) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        sequence: ++this.sequence,
        tick,
        fullState: state,
      }),
    );
  }

  sendEffect(event: EffectEvent, tick: number, lease: HostLease): void {
    if (!this.holdsLease(lease)) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        sequence: ++this.sequence,
        tick,
        effectEvent: event,
      }),
    );
  }

  sendCheckpoint(
    snapshot: CanvasSnapshot,
    checkpointRevision: number,
    final: boolean,
    lease: HostLease,
  ): void {
    if (!this.holdsLease(lease)) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        tick: snapshot.tick,
        checkpoint: {
          checkpointRevision,
          tick: snapshot.tick,
          snapshotJson: toJsonBytes(snapshot),
          final,
        },
      }),
    );
  }

  sendItemMutation(mutation: ItemMutation): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        itemMutation: mutation,
      }),
    );
  }

  beginItemEdit(request: BeginItemEdit): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        beginItemEdit: request,
      }),
    );
  }

  renewItemEdit(request: RenewItemEdit): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        renewItemEdit: request,
      }),
    );
  }

  endItemEdit(request: EndItemEdit): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        endItemEdit: request,
      }),
    );
  }

  sendItemEditPreview(preview: ItemEditPreview): void {
    this.transport.sendRealtime(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        sequence: ++this.sequence,
        itemEditPreview: preview,
      }),
    );
  }

  /** Spec 11.2. Yield the lease when the page is hidden or the loop is late. */
  yieldHost(reason: string, lease: HostLease): void {
    if (!this.holdsLease(lease)) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        hostControl: {
          kind: HostControlKind.HOST_CONTROL_YIELD,
          hostClientId: this.identityValue.clientId,
          hostEpoch: this.leaseValue.epoch,
          snapshotJson: new Uint8Array(),
          reason,
          eligible: false,
          leaseExpiresAtUnixMs: 0,
        },
      }),
    );
  }

  setHostEligible(eligible: boolean): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.roomId, {
        hostEpoch: this.leaseValue.epoch,
        hostControl: {
          kind: HostControlKind.HOST_CONTROL_ELIGIBILITY,
          hostClientId: this.identityValue.clientId,
          hostEpoch: this.leaseValue.epoch,
          snapshotJson: new Uint8Array(),
          reason: "",
          eligible,
          leaseExpiresAtUnixMs: 0,
        },
      }),
    );
  }

  // ---------- receiving ----------

  private receive(message: RoomEnvelope): void {
    if (message.error) {
      this.emit("error", message.error.code, message.error.message);
      return;
    }

    if (message.joinAccepted) {
      const accepted = message.joinAccepted;
      this.identityValue = Object.freeze({
        generation: this.identityValue.generation + 1,
        clientId: accepted.clientId,
        userId: accepted.userId,
        displayName: accepted.displayName,
        tickRate: accepted.tickRate || 60,
      });
      this.leaseValue = Object.freeze({
        epoch: accepted.hostEpoch,
        hostClientId: accepted.hostClientId,
        localClientId: accepted.clientId,
        // A reconnect may have assigned the lease to somebody else.
        isHost: accepted.hostClientId === accepted.clientId,
      });
      this.revisionValue = Object.freeze({ sceneRevision: accepted.sceneRevision });
      const canvas = fromJsonBytes<CanvasDefinition>(accepted.canvasDefinitionJson);
      const snapshot = fromJsonBytes<CanvasSnapshot>(accepted.snapshotJson);
      if (!canvas) {
        this.emit("error", "bad_canvas", "the server sent no canvas definition");
        return;
      }
      this.emit("joined", {
        roomId: this.joinDescriptor.roomId,
        canvasId: canvas.id,
        identity: this.identityValue,
        lease: this.leaseValue,
        revision: this.revisionValue,
        canvas,
        snapshot: snapshot ?? {
          schemaVersion: 1,
          canvasId: canvas.id,
          canvasVersion: canvas.version,
          sceneRevision: accepted.sceneRevision,
          hostEpoch: accepted.hostEpoch,
          checkpointRevision: 0,
          tick: 0,
          capturedAt: new Date().toISOString(),
          normalized: true,
          items: [],
          avatars: [],
        },
        roomWasSleeping: accepted.roomWasSleeping,
      });
      return;
    }

    if (message.presence) {
      this.presenceValue = Object.freeze({
        peers: Object.freeze(
          message.presence.peers.map((peer) => Object.freeze({ ...peer })),
        ),
      });
      this.emit("presence", message.presence.peers);
      return;
    }

    if (message.hostControl) {
      this.handleHostControl(message);
      return;
    }

    // Spec 11.1. Drop canonical state from an old epoch.
    const isState = message.stateDelta || message.fullState || message.effectEvent;
    if (isState && message.hostEpoch !== this.leaseValue.epoch) return;

    if (message.fullState) {
      this.emit("fullState", message.fullState, message.hostEpoch, message.tick);
      return;
    }
    if (message.stateDelta) {
      this.emit("stateDelta", message.stateDelta, message.hostEpoch, message.tick);
      return;
    }
    if (message.effectEvent) {
      this.emit("effect", message.effectEvent, message.tick);
      return;
    }
    if (message.playerInput) {
      this.emit("playerInput", message.playerInput, message.senderClientId);
      return;
    }
    if (message.itemEditPreview) {
      if (message.hostEpoch !== this.leaseValue.epoch) return;
      this.emit("itemEditPreview", message.itemEditPreview, message.senderClientId);
      return;
    }
    if (message.itemEditSessionResult) {
      const result = message.itemEditSessionResult;
      this.emit(
        "itemEditSessionResult",
        result,
        fromJsonBytes(result.itemInstanceJson),
      );
      return;
    }
    if (message.itemMutationResult) {
      const result = message.itemMutationResult;
      if (result.accepted) {
        this.revisionValue = Object.freeze({
          sceneRevision: Math.max(this.revisionValue.sceneRevision, result.sceneRevision),
        });
      }
      this.emit(
        "itemMutationResult",
        result,
        fromJsonBytes(result.itemInstanceJson),
      );
    }
  }

  private handleHostControl(message: RoomEnvelope): void {
    const control = message.hostControl!;
    this.leaseValue = Object.freeze({
      epoch: control.hostEpoch,
      hostClientId: control.hostClientId,
      localClientId: this.identityValue.clientId,
      isHost:
        control.kind === HostControlKind.HOST_CONTROL_GRANTED ||
        control.hostClientId === this.identityValue.clientId,
    });

    if (control.kind === HostControlKind.HOST_CONTROL_GRANTED) {
      this.emit(
        "hostGranted",
        this.leaseValue,
        fromJsonBytes<CanvasSnapshot>(control.snapshotJson),
        control.reason,
      );
      return;
    }
    if (control.kind === HostControlKind.HOST_CONTROL_REVOKED) {
      this.emit("hostChanged", this.leaseValue, control.reason);
      return;
    }
    if (control.kind === HostControlKind.HOST_CONTROL_YIELD_REQUEST) {
      this.yieldHost("server_request", this.leaseValue);
    }
  }
}
