import type { RoomEnvelope } from "@canvas-physics/protocol";
import { WebSocketRoomTransport } from "../../src/index.js";

export interface LossOptions {
  /** Share of realtime packets to drop, from 0 to 1. */
  outboundLoss?: number;
  /** Share of inbound packets to drop, from 0 to 1. */
  inboundLoss?: number;
  /** Extra delay in milliseconds before an inbound packet is delivered. */
  inboundDelayMs?: number;
}

/**
 * Phase 6, spec 20. A transport that loses and delays realtime packets, so a
 * test can prove that the keyframe repairs a client that missed deltas. Only
 * realtime packets are dropped. A reliable packet must still arrive, because a
 * real WebSocket does not lose one without closing.
 */
export class LossyTransport extends WebSocketRoomTransport {
  droppedOut = 0;
  droppedIn = 0;

  constructor(private readonly loss: LossOptions = {}) {
    super();
  }

  override sendRealtime(message: RoomEnvelope): void {
    if (Math.random() < (this.loss.outboundLoss ?? 0)) {
      this.droppedOut++;
      return;
    }
    super.sendRealtime(message);
  }

  protected override deliver(envelope: RoomEnvelope): void {
    if (Math.random() < (this.loss.inboundLoss ?? 0) && isRealtime(envelope)) {
      this.droppedIn++;
      return;
    }
    const delay = this.loss.inboundDelayMs ?? 0;
    if (delay <= 0) {
      super.deliver(envelope);
      return;
    }
    setTimeout(() => super.deliver(envelope), delay);
  }
}

/** A realtime payload may be lost. A coordination payload may not. */
const isRealtime = (envelope: RoomEnvelope): boolean =>
  envelope.stateDelta !== undefined ||
  envelope.playerInput !== undefined ||
  envelope.effectEvent !== undefined;
