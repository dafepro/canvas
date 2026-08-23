import { describe, expect, it } from "vitest";
import { encodeEnvelope, type RoomEnvelope } from "@canvas-physics/protocol";
import {
  runRoomTransportConformance,
  type RoomTransportConformanceFixture,
} from "../src/testing/index.js";
import {
  emptyTraffic,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/net/transport.js";

class LoopbackTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  readonly outbound: RoomEnvelope[] = [];
  private readonly messageHandlers = new Set<(message: RoomEnvelope) => void>();
  private readonly statusHandlers = new Set<(status: TransportStatus, detail?: string) => void>();

  constructor(
    private readonly options: { trackTraffic?: boolean; reconnect?: boolean } = {},
  ) {}

  async connect(_join: JoinDescriptor): Promise<void> {
    this.setStatus("connecting");
    this.setStatus("open");
  }

  sendReliable(message: RoomEnvelope): void { this.write(message); }
  sendRealtime(message: RoomEnvelope): void { this.write(message); }

  onMessage(handler: (message: RoomEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: TransportStatus, detail?: string) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  close(): void { this.setStatus("closed"); }

  deliver(message: RoomEnvelope): void {
    if (this.options.trackTraffic !== false) {
      this.traffic.inboundBytes += encodeEnvelope(message).byteLength;
      this.traffic.inboundMessages++;
    }
    for (const handler of this.messageHandlers) handler(structuredClone(message));
  }

  interrupt(detail: string): void {
    this.setStatus("reconnecting", detail);
    if (this.options.reconnect !== false) queueMicrotask(() => this.setStatus("open"));
  }

  private write(message: RoomEnvelope): void {
    if (this.status !== "open") return;
    if (this.options.trackTraffic !== false) {
      this.traffic.outboundBytes += encodeEnvelope(message).byteLength;
      this.traffic.outboundMessages++;
    }
    this.outbound.push(structuredClone(message));
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status, detail);
  }
}

const fixture = (
  options: { trackTraffic?: boolean; reconnect?: boolean } = {},
): RoomTransportConformanceFixture => ({
  timeoutMs: 100,
  create: () => {
    const transport = new LoopbackTransport(options);
    return {
      transport,
      join: { roomId: "transport-conformance", serverUrl: "https://rooms.test" },
      nextOutbound: async () => {
        const deadline = Date.now() + 100;
        while (transport.outbound.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const message = transport.outbound.shift();
        if (!message) throw new Error("no outbound message");
        return message;
      },
      deliverInbound: (message) => transport.deliver(message),
      interrupt: (detail) => transport.interrupt(detail),
    };
  },
});

describe("external room transport conformance", () => {
  it("accepts a lifecycle-aware ordered transport with cumulative traffic", async () => {
    const report = await runRoomTransportConformance(fixture());

    expect(report).toEqual({
      ok: true,
      checksRun: 8,
      issues: [],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.issues)).toBe(true);
  });

  it("reports traffic and reconnect violations without escaping the kit", async () => {
    const report = await runRoomTransportConformance(fixture({
      trackTraffic: false,
      reconnect: false,
    }));

    expect(report.ok).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "traffic_invalid",
      "reconnect_failed",
    ]));
  });
});
