import {
  decodeEnvelope,
  encodeEnvelope,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import {
  emptyTraffic,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
  type TransportTraffic,
  type Unsubscribe,
} from "./transport.js";

export interface WebSocketTransportOptions {
  /** Supplies a short-lived WebSocket subprotocol ticket for every attempt. */
  credentialProvider: RealtimeCredentialProvider;
  /** Maximum time for one socket handshake. Defaults to 10 seconds. */
  connectTimeoutMs?: number;
  /** Reconnect delays in milliseconds. The last value repeats. */
  backoffMs?: number[];
  maxReconnects?: number;
  /** Maximum reliable messages retained across a reconnect. Defaults to 256. */
  maxPendingReliable?: number;
}

export type RealtimeCredentialProvider = () => Promise<string>;

export const REALTIME_SUBPROTOCOL = "canvas-realtime";

/** Creates an identity credential understood only by roomsdk.DevAuthenticator. */
export const devRealtimeCredential = (
  userId: string,
  displayName = userId,
): string => {
  const bytes = new TextEncoder().encode(JSON.stringify({ userId, displayName }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `canvas-dev.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
};

/**
 * Spec 12.1. The V1 transport. One socket carries both channels, so the
 * reliable and realtime methods differ only in how a later WebRTC transport
 * will treat them.
 */
export class WebSocketRoomTransport implements RoomTransport {
  private socket?: WebSocket;
  private join?: JoinDescriptor;
  private readonly messageHandlers = new Set<(message: RoomEnvelope) => void>();
  private readonly statusHandlers = new Set<
    (status: TransportStatus, detail?: string) => void
  >();
  private currentStatus: TransportStatus = "idle";
  private reconnects = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closedByCaller = false;
  private failed = false;
  private hasOpened = false;
  private readonly backoffMs: number[];
  private readonly maxReconnects: number;
  private readonly maxPendingReliable: number;
  private readonly pendingReliable: Uint8Array[] = [];
  private readonly connectTimeoutMs: number;
  private readonly credentialProvider: RealtimeCredentialProvider;
  readonly traffic: TransportTraffic = emptyTraffic();

  constructor(options: WebSocketTransportOptions) {
    this.credentialProvider = options.credentialProvider;
    this.connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? 10_000);
    this.backoffMs = options.backoffMs ?? [250, 500, 1000, 2000, 4000];
    this.maxReconnects = options.maxReconnects ?? 20;
    this.maxPendingReliable = Math.max(1, Math.floor(options.maxPendingReliable ?? 256));
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  async connect(join: JoinDescriptor): Promise<void> {
    this.join = join;
    this.closedByCaller = false;
    this.failed = false;
    this.hasOpened = false;
    try {
      await this.open();
    } catch (error) {
      // A rejected initial connect is terminal. Reconnect attempts are started
      // only after a socket has opened successfully and manage their own retry.
      if (!this.hasOpened && !this.closedByCaller && this.currentStatus !== "failed") {
        this.failTransport(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private url(join: JoinDescriptor): string {
    const base = new URL(join.serverUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `/v1/realtime/rooms/${encodeURIComponent(join.roomId)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }

  private async open(): Promise<void> {
    const join = this.join;
    if (!join) throw new Error("connect was not called");

    this.setStatus(this.reconnects === 0 ? "credentials" : "reconnecting");
    const credential = await this.credentialProvider();
    if (!credential || credential === REALTIME_SUBPROTOCOL || /[\s,]/u.test(credential)) {
      throw new Error("credential provider returned an invalid WebSocket subprotocol");
    }
    this.setStatus("connecting");
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url(join), [REALTIME_SUBPROTOCOL, credential]);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let opened = false;
      let timedOut = false;
      const handshakeTimer = setTimeout(() => {
        if (opened || socket.readyState === WebSocket.OPEN) return;
        timedOut = true;
        if (this.socket === socket) this.socket = undefined;
        const message = `websocket connection timed out after ${this.connectTimeoutMs}ms`;
        this.failed = true;
        this.pendingReliable.length = 0;
        this.setStatus("failed", message);
        socket.close(4000, "connection timeout");
        reject(new Error(message));
      }, this.connectTimeoutMs);
      const finishHandshake = () => clearTimeout(handshakeTimer);

      socket.onopen = () => {
        opened = true;
        this.hasOpened = true;
        finishHandshake();
        this.reconnects = 0;
        this.setStatus("open");
        this.flushReliable();
        resolve();
      };

      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        this.traffic.inboundBytes += event.data.byteLength;
        this.traffic.inboundMessages++;
        this.observeInbound(new Uint8Array(event.data));
        let envelope: RoomEnvelope;
        try {
          envelope = decodeEnvelope(new Uint8Array(event.data));
        } catch {
          return;
        }
        this.deliver(envelope);
      };

      socket.onerror = () => {
        if (!opened) {
          finishHandshake();
          reject(new Error("websocket connection failed"));
        }
      };

      socket.onclose = (event) => {
        finishHandshake();
        if (this.socket === socket) this.socket = undefined;
        if (this.closedByCaller) {
          this.setStatus("closed");
          return;
        }
        if (this.failed) return;
        if (!opened) {
          if (timedOut) return;
          const detail = event.reason || `code ${event.code}`;
          this.scheduleReconnect(detail);
          reject(new Error(`websocket closed before opening: ${detail}`));
          return;
        }
        this.scheduleReconnect(event.reason || `code ${event.code}`);
      };
    });
  }

  private scheduleReconnect(detail: string): void {
    if (this.failed || this.closedByCaller) return;
    if (this.reconnects >= this.maxReconnects) {
      this.failed = true;
      this.pendingReliable.length = 0;
      this.setStatus("failed", detail);
      return;
    }
    const delay =
      this.backoffMs[Math.min(this.reconnects, this.backoffMs.length - 1)] ?? 1000;
    this.reconnects++;
    this.setStatus("reconnecting", detail);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open().catch((error) => {
        // A socket close schedules itself. Credential failures happen before a
        // socket exists and therefore need another attempt here.
        if (!this.socket && !this.reconnectTimer && !this.closedByCaller) {
          this.scheduleReconnect(error instanceof Error ? error.message : String(error));
        }
      });
    }, delay);
  }

  sendReliable(message: RoomEnvelope): void {
    const bytes = encodeEnvelope(message);
    if (this.writeBytes(bytes)) return;
    if (
      !this.join ||
      this.closedByCaller ||
      this.failed ||
      this.currentStatus === "idle" ||
      this.currentStatus === "closed" ||
      this.currentStatus === "failed"
    ) return;
    if (this.pendingReliable.length >= this.maxPendingReliable) {
      this.failReliableQueue();
      return;
    }
    this.pendingReliable.push(bytes);
  }

  sendRealtime(message: RoomEnvelope): void {
    // Spec 12.2: an old transform packet is less useful than a newer one, so a
    // full send buffer drops the packet instead of queueing it.
    if (this.socket && this.socket.bufferedAmount > 1 << 20) {
      this.traffic.droppedOutbound++;
      return;
    }
    this.write(message);
  }

  /**
   * Hands one decoded envelope to the handlers. A subclass overrides this to
   * delay or to drop a packet in a test.
   */
  protected deliver(envelope: RoomEnvelope): void {
    for (const handler of this.messageHandlers) handler(envelope);
  }

  /**
   * A hook for a subclass that measures traffic. The base class does nothing,
   * so a production transport pays only one empty call for each frame.
   */
  protected observeInbound(_bytes: Uint8Array): void {}

  /**
   * Breaks the current socket without marking the transport as caller-closed.
   * Testing subclasses use this to exercise the normal reconnect path against
   * a live server without exposing the production socket itself.
   */
  protected interruptConnection(): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.close(4000, "connection interrupted");
    return true;
  }

  private write(message: RoomEnvelope): void {
    this.writeBytes(encodeEnvelope(message));
  }

  private writeBytes(bytes: Uint8Array): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.traffic.outboundBytes += bytes.byteLength;
    this.traffic.outboundMessages++;
    this.socket.send(bytes);
    return true;
  }

  private flushReliable(): void {
    while (this.pendingReliable.length > 0) {
      const bytes = this.pendingReliable[0]!;
      if (!this.writeBytes(bytes)) return;
      this.pendingReliable.shift();
    }
  }

  private failReliableQueue(): void {
    const detail = `reliable send queue exceeded ${this.maxPendingReliable} messages`;
    this.pendingReliable.length = 0;
    this.failed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(4001, "reliable send queue exceeded");
    this.socket = undefined;
    this.setStatus("failed", detail);
  }

  private failTransport(detail: string): void {
    this.failed = true;
    this.pendingReliable.length = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(4000, "initial connection failed");
    this.socket = undefined;
    this.setStatus("failed", detail);
  }

  onMessage(handler: (message: RoomEnvelope) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(
    handler: (status: TransportStatus, detail?: string) => void,
  ): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  close(): void {
    this.closedByCaller = true;
    this.failed = false;
    this.pendingReliable.length = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "client closed the room");
    this.socket = undefined;
    this.setStatus("closed");
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.currentStatus = status;
    for (const handler of this.statusHandlers) handler(status, detail);
  }
}
