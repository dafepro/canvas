import type { RoomEnvelope } from "@canvas-physics/protocol";
import {
  WebSocketRoomTransport,
  type WebSocketTransportOptions,
} from "../net/websocket-transport.js";

export interface NetworkFaultProfile {
  /** Share of realtime outbound packets to drop, from 0 to 1. */
  outboundLoss?: number;
  /** Share of realtime inbound packets to drop, from 0 to 1. */
  inboundLoss?: number;
  /** Baseline one-way delay applied to every inbound packet. */
  inboundDelayMs?: number;
  /** Symmetric random variation added to inboundDelayMs. */
  inboundJitterMs?: number;
  /** Hold every nth realtime packet long enough for a later packet to pass it. */
  reorderEvery?: number;
  /** Additional hold for reordered packets. */
  reorderDelayMs?: number;
  /** Injectable source for deterministic loss and jitter tests. */
  random?: () => number;
}

export interface FaultInjectingWebSocketOptions extends WebSocketTransportOptions {
  faults?: NetworkFaultProfile;
}

/**
 * Testing transport that injects repeatable network faults around a real
 * WebSocket. Reliable packets may be delayed but are never dropped or
 * reordered. Realtime packets may additionally be lost or held so a later
 * packet arrives first.
 */
export class FaultInjectingWebSocketTransport extends WebSocketRoomTransport {
  droppedOut = 0;
  droppedIn = 0;
  delayedIn = 0;
  reorderedIn = 0;

  private realtimeInbound = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly random: () => number;
  private readonly faults: NetworkFaultProfile;

  constructor(options: FaultInjectingWebSocketOptions) {
    super(options);
    this.faults = options.faults ?? {};
    this.random = this.faults.random ?? Math.random;
  }

  override sendRealtime(message: RoomEnvelope): void {
    if (this.random() < clampRate(this.faults.outboundLoss)) {
      this.droppedOut++;
      return;
    }
    super.sendRealtime(message);
  }

  /** Breaks the live socket and lets the ordinary reconnect machinery recover. */
  interrupt(): boolean {
    return this.interruptConnection();
  }

  protected override deliver(envelope: RoomEnvelope): void {
    const realtime = isRealtime(envelope);
    if (realtime && this.random() < clampRate(this.faults.inboundLoss)) {
      this.droppedIn++;
      return;
    }

    let delay = Math.max(0, this.faults.inboundDelayMs ?? 0);
    const jitter = Math.max(0, this.faults.inboundJitterMs ?? 0);
    if (jitter > 0) delay = Math.max(0, delay + (this.random() * 2 - 1) * jitter);

    if (realtime) {
      this.realtimeInbound++;
      const every = Math.floor(this.faults.reorderEvery ?? 0);
      if (every > 1 && this.realtimeInbound % every === 0) {
        delay += Math.max(1, this.faults.reorderDelayMs ?? 100);
        this.reorderedIn++;
      }
    }

    if (delay <= 0) {
      super.deliver(envelope);
      return;
    }

    this.delayedIn++;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      super.deliver(envelope);
    }, delay);
    this.timers.add(timer);
  }

  override close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    super.close();
  }
}

const clampRate = (rate: number | undefined): number =>
  Math.min(1, Math.max(0, rate ?? 0));

/** A realtime payload may be lost or reordered; coordination payloads may not. */
const isRealtime = (envelope: RoomEnvelope): boolean =>
  envelope.stateDelta !== undefined ||
  envelope.playerInput !== undefined ||
  envelope.effectEvent !== undefined;
