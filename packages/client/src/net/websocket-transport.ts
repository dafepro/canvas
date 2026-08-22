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
  /** Reconnect delays in milliseconds. The last value repeats. */
  backoffMs?: number[];
  maxReconnects?: number;
}

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
  private readonly backoffMs: number[];
  private readonly maxReconnects: number;
  readonly traffic: TransportTraffic = emptyTraffic();

  constructor(options: WebSocketTransportOptions = {}) {
    this.backoffMs = options.backoffMs ?? [250, 500, 1000, 2000, 4000];
    this.maxReconnects = options.maxReconnects ?? 20;
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(join: JoinDescriptor): Promise<void> {
    this.join = join;
    this.closedByCaller = false;
    return this.open();
  }

  private url(join: JoinDescriptor): string {
    const base = new URL(join.serverUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `/v1/realtime/canvases/${encodeURIComponent(join.canvasId)}`;
    base.searchParams.set("user", join.userId);
    base.searchParams.set("name", join.displayName);
    return base.toString();
  }

  private open(): Promise<void> {
    const join = this.join;
    if (!join) return Promise.reject(new Error("connect was not called"));

    this.setStatus(this.reconnects === 0 ? "connecting" : "reconnecting");
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url(join));
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onopen = () => {
        this.reconnects = 0;
        this.setStatus("open");
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
        if (this.currentStatus === "connecting") {
          reject(new Error("websocket connection failed"));
        }
      };

      socket.onclose = (event) => {
        this.socket = undefined;
        if (this.closedByCaller) {
          this.setStatus("closed");
          return;
        }
        this.scheduleReconnect(event.reason || `code ${event.code}`);
      };
    });
  }

  private scheduleReconnect(detail: string): void {
    if (this.reconnects >= this.maxReconnects) {
      this.setStatus("failed", detail);
      return;
    }
    const delay =
      this.backoffMs[Math.min(this.reconnects, this.backoffMs.length - 1)] ?? 1000;
    this.reconnects++;
    this.setStatus("reconnecting", detail);
    this.reconnectTimer = setTimeout(() => {
      void this.open().catch(() => {
        /* the close handler schedules the next attempt */
      });
    }, delay);
  }

  sendReliable(message: RoomEnvelope): void {
    this.write(message);
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

  private write(message: RoomEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const bytes = encodeEnvelope(message);
    this.traffic.outboundBytes += bytes.byteLength;
    this.traffic.outboundMessages++;
    this.socket.send(bytes);
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
