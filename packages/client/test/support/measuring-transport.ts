import { decodeEnvelope } from "@canvas-physics/protocol";
import {
  WebSocketRoomTransport,
  type RealtimeCredentialProvider,
} from "../../src/index.js";

/**
 * A transport that also counts inbound bytes for each payload kind. Phase 6
 * uses it to find which message type spends the network budget.
 */
export class MeasuringTransport extends WebSocketRoomTransport {
  readonly inboundBytesByKind = new Map<string, number>();
  readonly inboundCountByKind = new Map<string, number>();

  constructor(credentialProvider: RealtimeCredentialProvider) {
    super({ credentialProvider });
  }

  private tally(kind: string, bytes: number): void {
    this.inboundBytesByKind.set(kind, (this.inboundBytesByKind.get(kind) ?? 0) + bytes);
    this.inboundCountByKind.set(kind, (this.inboundCountByKind.get(kind) ?? 0) + 1);
  }

  report(seconds: number): string {
    const rows = [...this.inboundBytesByKind.entries()].sort((a, b) => b[1] - a[1]);
    return rows
      .map(
        ([kind, bytes]) =>
          `${kind} ${(bytes / seconds / 1024).toFixed(2)} KB/s over ` +
          `${this.inboundCountByKind.get(kind)} messages`,
      )
      .join("\n");
  }

  /** Called by the base class for each inbound frame. */
  protected observeInbound(bytes: Uint8Array): void {
    try {
      const envelope = decodeEnvelope(bytes);
      const kind =
        Object.entries(envelope).find(
          ([, value]) => value !== undefined && value !== null && typeof value === "object",
        )?.[0] ?? "unknown";
      this.tally(kind, bytes.byteLength);
    } catch {
      this.tally("undecodable", bytes.byteLength);
    }
  }
}
