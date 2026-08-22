import {
  PROTOCOL_VERSION,
  envelope as newEnvelope,
  fromJsonBytes,
  toJsonBytes,
  HostControlKind,
  type DurableCommand,
  type FullState,
  type Peer,
  type PlayerInput,
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
  clientId: string;
  canvas: CanvasDefinition;
  snapshot: CanvasSnapshot;
  sceneRevision: number;
  hostEpoch: number;
  hostClientId: string;
  roomWasSleeping: boolean;
  tickRate: number;
}

export interface RoomClientEvents {
  joined(result: RoomJoinResult): void;
  presence(peers: Peer[]): void;
  /** This client is now the simulation host. */
  hostGranted(epoch: number, snapshot: CanvasSnapshot | undefined): void;
  /** Another client is the host, or this client lost the lease. */
  hostChanged(epoch: number, hostClientId: string, reason: string): void;
  fullState(state: FullState, epoch: number, tick: number): void;
  stateDelta(delta: StateDelta, epoch: number, tick: number): void;
  effect(event: EffectEvent, tick: number): void;
  playerInput(input: PlayerInput, fromClientId: string): void;
  durableAccepted(command: DurableCommand, sceneRevision: number, itemJson?: unknown): void;
  durableRejected(command: DurableCommand, reason: string): void;
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

  clientId = "";
  hostEpoch = 0;
  hostClientId = "";
  sceneRevision = 0;
  tickRate = 60;
  isHost = false;
  peers: Peer[] = [];
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
    this.transport.onStatus((status, detail) => this.emit("status", status, detail));
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
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        join: {
          canvasId: this.joinDescriptor.canvasId,
          protocolVersion: PROTOCOL_VERSION,
          userId: this.joinDescriptor.userId,
          displayName: this.joinDescriptor.displayName,
          definitions: this.definitions,
        },
      }),
    );
    this.startHeartbeat();
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.transport.close();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.transport.sendReliable(
        newEnvelope(this.joinDescriptor.canvasId, {
          hostEpoch: this.hostEpoch,
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
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        sequence: ++this.sequence,
        playerInput: input,
      }),
    );
  }

  sendStateDelta(delta: StateDelta, tick: number): void {
    if (!this.isHost) return;
    this.transport.sendRealtime(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        sequence: ++this.sequence,
        tick,
        stateDelta: delta,
      }),
    );
  }

  sendFullState(state: FullState, tick: number): void {
    if (!this.isHost) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        sequence: ++this.sequence,
        tick,
        fullState: state,
      }),
    );
  }

  sendEffect(event: EffectEvent, tick: number): void {
    if (!this.isHost) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        sequence: ++this.sequence,
        tick,
        effectEvent: event,
      }),
    );
  }

  sendCheckpoint(snapshot: CanvasSnapshot, checkpointRevision: number, final = false): void {
    if (!this.isHost) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
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

  sendDurableCommand(command: DurableCommand): void {
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        durableCommand: command,
      }),
    );
  }

  /** Spec 11.2. Yield the lease when the page is hidden or the loop is late. */
  yieldHost(reason: string): void {
    if (!this.isHost) return;
    this.transport.sendReliable(
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        hostControl: {
          kind: HostControlKind.HOST_CONTROL_YIELD,
          hostClientId: this.clientId,
          hostEpoch: this.hostEpoch,
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
      newEnvelope(this.joinDescriptor.canvasId, {
        hostEpoch: this.hostEpoch,
        hostControl: {
          kind: HostControlKind.HOST_CONTROL_ELIGIBILITY,
          hostClientId: this.clientId,
          hostEpoch: this.hostEpoch,
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
      this.clientId = accepted.clientId;
      this.hostEpoch = accepted.hostEpoch;
      this.hostClientId = accepted.hostClientId;
      this.sceneRevision = accepted.sceneRevision;
      this.tickRate = accepted.tickRate || 60;
      const canvas = fromJsonBytes<CanvasDefinition>(accepted.canvasDefinitionJson);
      const snapshot = fromJsonBytes<CanvasSnapshot>(accepted.snapshotJson);
      if (!canvas) {
        this.emit("error", "bad_canvas", "the server sent no canvas definition");
        return;
      }
      this.emit("joined", {
        clientId: accepted.clientId,
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
        },
        sceneRevision: accepted.sceneRevision,
        hostEpoch: accepted.hostEpoch,
        hostClientId: accepted.hostClientId,
        roomWasSleeping: accepted.roomWasSleeping,
        tickRate: this.tickRate,
      });
      return;
    }

    if (message.presence) {
      this.peers = message.presence.peers;
      this.emit("presence", message.presence.peers);
      return;
    }

    if (message.hostControl) {
      this.handleHostControl(message);
      return;
    }

    // Spec 11.1. Drop canonical state from an old epoch.
    const isState = message.stateDelta || message.fullState || message.effectEvent;
    if (isState && message.hostEpoch !== this.hostEpoch) return;

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
    if (message.durableResult) {
      const result = message.durableResult;
      const command = result.command;
      if (!command) return;
      if (result.accepted) {
        this.sceneRevision = result.sceneRevision;
        this.emit(
          "durableAccepted",
          command,
          result.sceneRevision,
          fromJsonBytes(result.itemInstanceJson),
        );
      } else {
        this.emit("durableRejected", command, result.rejectReason);
      }
    }
  }

  private handleHostControl(message: RoomEnvelope): void {
    const control = message.hostControl!;
    this.hostEpoch = control.hostEpoch;
    this.hostClientId = control.hostClientId;

    if (control.kind === HostControlKind.HOST_CONTROL_GRANTED) {
      this.isHost = true;
      this.emit(
        "hostGranted",
        control.hostEpoch,
        fromJsonBytes<CanvasSnapshot>(control.snapshotJson),
      );
      return;
    }
    if (control.kind === HostControlKind.HOST_CONTROL_REVOKED) {
      this.isHost = control.hostClientId === this.clientId;
      this.emit("hostChanged", control.hostEpoch, control.hostClientId, control.reason);
      return;
    }
    if (control.kind === HostControlKind.HOST_CONTROL_YIELD_REQUEST) {
      this.yieldHost("server_request");
    }
  }
}
