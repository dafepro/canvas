import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomEnvelope } from "@canvas-physics/protocol";
import { FaultInjectingWebSocketTransport } from "../src/testing/index.js";

class ProbeTransport extends FaultInjectingWebSocketTransport {
  inject(envelope: RoomEnvelope): void {
    this.deliver(envelope);
  }
}

const realtime = (sequence: number): RoomEnvelope => ({
  roomId: "fault-lab",
  hostEpoch: 1,
  sequence,
  tick: sequence,
  senderClientId: "host",
  stateDelta: { entities: [] },
});

describe("deterministic network fault injection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers later realtime packets ahead of a deliberately held packet", () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const transport = new ProbeTransport({
      credentialProvider: async () => "unused",
      faults: { inboundDelayMs: 50, reorderEvery: 2, reorderDelayMs: 80 },
    });
    transport.onMessage((message) => received.push(message.sequence));

    transport.inject(realtime(1));
    transport.inject(realtime(2));
    transport.inject(realtime(3));

    vi.advanceTimersByTime(50);
    expect(received).toEqual([1, 3]);
    vi.advanceTimersByTime(80);
    expect(received).toEqual([1, 3, 2]);
    expect(transport.reorderedIn).toBe(1);
  });

  it("reports that an idle transport has no live connection to interrupt", () => {
    const transport = new ProbeTransport({
      credentialProvider: async () => "unused",
    });

    expect(transport.interrupt()).toBe(false);
    expect(transport.status).toBe("idle");
  });

  it("uses an injected random source for repeatable packet loss", () => {
    const received: number[] = [];
    const samples = [0.1, 0.9, 0.2, 0.8];
    const transport = new ProbeTransport({
      credentialProvider: async () => "unused",
      faults: { inboundLoss: 0.5, random: () => samples.shift() ?? 1 },
    });
    transport.onMessage((message) => received.push(message.sequence));

    for (let sequence = 1; sequence <= 4; sequence++) {
      transport.inject(realtime(sequence));
    }

    expect(received).toEqual([2, 4]);
    expect(transport.droppedIn).toBe(2);
  });

  it("cancels delayed deliveries when the transport closes", () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const transport = new ProbeTransport({
      credentialProvider: async () => "unused",
      faults: { inboundDelayMs: 100 },
    });
    transport.onMessage((message) => received.push(message.sequence));

    transport.inject(realtime(1));
    transport.close();
    vi.runAllTimers();

    expect(received).toEqual([]);
  });
});
