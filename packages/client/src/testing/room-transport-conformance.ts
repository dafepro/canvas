import { encodeEnvelope, type RoomEnvelope } from "@canvas-physics/protocol";
import type {
  JoinDescriptor,
  RoomTransport,
  TransportStatus,
  TransportTraffic,
} from "../net/transport.js";

export type RoomTransportConformanceIssueCode =
  | "fixture_failed"
  | "initial_state_invalid"
  | "connect_failed"
  | "reliable_delivery_failed"
  | "realtime_delivery_failed"
  | "inbound_delivery_failed"
  | "reconnect_failed"
  | "traffic_invalid"
  | "close_failed";

export interface RoomTransportConformanceIssue {
  readonly code: RoomTransportConformanceIssueCode;
  readonly message: string;
}

export interface RoomTransportConformanceReport {
  readonly ok: boolean;
  readonly checksRun: number;
  readonly issues: readonly Readonly<RoomTransportConformanceIssue>[];
}

/**
 * Adapter-controlled peer for the transport under test. A WebSocket fixture
 * normally implements this with a local test server; a WebRTC fixture can use
 * its remote data-channel endpoint.
 */
export interface RoomTransportConformanceHarness {
  readonly transport: RoomTransport;
  readonly join: JoinDescriptor;
  /** Resolves with the next envelope received from either outbound channel. */
  nextOutbound(): Promise<RoomEnvelope>;
  /** Sends one decoded envelope from the peer to the transport. */
  deliverInbound(message: RoomEnvelope): void | Promise<void>;
  /** Breaks the active connection without closing the transport by caller request. */
  interrupt(detail: string): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface RoomTransportConformanceFixture {
  create(): RoomTransportConformanceHarness | Promise<RoomTransportConformanceHarness>;
  /** Maximum time for one asynchronous observation. Defaults to 2 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Framework-neutral contract checks for a consumer-owned RoomTransport.
 * Consumers assert `report.issues` with their test framework of choice.
 */
export const runRoomTransportConformance = async (
  fixture: RoomTransportConformanceFixture,
): Promise<Readonly<RoomTransportConformanceReport>> => {
  const issues: RoomTransportConformanceIssue[] = [];
  const timeoutMs = fixture.timeoutMs ?? 2_000;
  let checksRun = 0;
  const add = (code: RoomTransportConformanceIssueCode, message: string): void => {
    issues.push(Object.freeze({ code, message }));
  };

  let harness: RoomTransportConformanceHarness;
  try {
    harness = await fixture.create();
  } catch (cause) {
    add("fixture_failed", describeFailure("fixture creation failed", cause));
    return freezeReport(checksRun, issues);
  }

  const transport = harness.transport;
  const statuses: { status: TransportStatus; detail?: string }[] = [];
  const received: RoomEnvelope[] = [];
  let unsubscribeStatus = (): void => {};
  let unsubscribeMessage = (): void => {};
  try {
    unsubscribeStatus = transport.onStatus((status, detail) => {
      statuses.push({ status, detail });
    });
    unsubscribeMessage = transport.onMessage((message) => {
      received.push(message);
    });
  } catch (cause) {
    add("fixture_failed", describeFailure("listener registration failed", cause));
    try { await harness.dispose?.(); } catch { /* The primary setup issue is sufficient. */ }
    return freezeReport(checksRun, issues);
  }

  const check = async (
    code: RoomTransportConformanceIssueCode,
    exercise: () => void | Promise<void>,
  ): Promise<boolean> => {
    checksRun++;
    try {
      await exercise();
      return true;
    } catch (cause) {
      add(code, describeFailure(code.replaceAll("_", " "), cause));
      return false;
    }
  };

  try {
    await check("initial_state_invalid", () => {
      assert(transport.status === "idle", `new transport status was '${transport.status}', want 'idle'`);
      assertTrafficShape(transport.traffic);
      assert(
        Object.values(transport.traffic).every((value) => value === 0),
        "new transport traffic counters must start at zero",
      );
    });

    const connected = await check("connect_failed", async () => {
      await withTimeout(transport.connect(harness.join), timeoutMs, "connect did not resolve");
      assert(transport.status === "open", `connect resolved with status '${transport.status}'`);
      const connectingIndex = statuses.findIndex(({ status }) => status === "connecting");
      const openIndex = statuses.findIndex(({ status }) => status === "open");
      assert(connectingIndex >= 0, "connect did not publish 'connecting'");
      assert(openIndex > connectingIndex, "connect did not publish 'open' after 'connecting'");
    });

    await check("reliable_delivery_failed", async () => {
      assert(connected, "reliable delivery requires a successful connection");
      const first = envelope(101);
      const second = envelope(102);
      transport.sendReliable(first);
      transport.sendReliable(second);
      const observedFirst = await withTimeout(
        harness.nextOutbound(), timeoutMs, "first reliable envelope was not delivered",
      );
      const observedSecond = await withTimeout(
        harness.nextOutbound(), timeoutMs, "second reliable envelope was not delivered",
      );
      assertEnvelope(observedFirst, first, "first reliable envelope changed");
      assertEnvelope(observedSecond, second, "reliable envelope order changed");
    });

    await check("realtime_delivery_failed", async () => {
      assert(connected, "realtime delivery requires a successful connection");
      const expected = envelope(201);
      transport.sendRealtime(expected);
      const observed = await withTimeout(
        harness.nextOutbound(), timeoutMs, "uncongested realtime envelope was not delivered",
      );
      assertEnvelope(observed, expected, "realtime envelope changed");
    });

    await check("inbound_delivery_failed", async () => {
      let removedListenerCalls = 0;
      const remove = transport.onMessage(() => { removedListenerCalls++; });
      remove();
      const expected = envelope(301);
      await harness.deliverInbound(expected);
      await waitUntil(() => received.length === 1, timeoutMs, "inbound listener was not called");
      assertEnvelope(received[0]!, expected, "inbound envelope changed");
      assert(removedListenerCalls === 0, "an unsubscribed message listener was called");

      unsubscribeMessage();
      await harness.deliverInbound(envelope(302));
      await nextTurn();
      assert(received.length === 1, "message unsubscribe did not stop later delivery");
    });

    await check("traffic_invalid", () => {
      assertTrafficShape(transport.traffic);
      assert(transport.traffic.outboundMessages >= 3, "outbound message counter did not advance");
      assert(transport.traffic.inboundMessages >= 2, "inbound message counter did not advance");
      assert(transport.traffic.outboundBytes > 0, "outbound byte counter did not advance");
      assert(transport.traffic.inboundBytes > 0, "inbound byte counter did not advance");
    });

    await check("reconnect_failed", async () => {
      assert(connected, "reconnect requires a successful initial connection");
      const before = statuses.length;
      await harness.interrupt("conformance interruption");
      await waitUntil(() => {
        const later = statuses.slice(before).map(({ status }) => status);
        const reconnecting = later.indexOf("reconnecting");
        return reconnecting >= 0 && later.indexOf("open", reconnecting + 1) > reconnecting;
      }, timeoutMs, "transport did not publish reconnecting then open");
      assert(transport.status === "open", `transport recovered with status '${transport.status}'`);

      const outbound = envelope(401);
      transport.sendReliable(outbound);
      assertEnvelope(
        await withTimeout(harness.nextOutbound(), timeoutMs, "post-reconnect send failed"),
        outbound,
        "post-reconnect envelope changed",
      );

      const postReconnectMessages: RoomEnvelope[] = [];
      const remove = transport.onMessage((message) => postReconnectMessages.push(message));
      const inbound = envelope(402);
      await harness.deliverInbound(inbound);
      await waitUntil(
        () => postReconnectMessages.length === 1,
        timeoutMs,
        "post-reconnect receive failed",
      );
      remove();
      assertEnvelope(postReconnectMessages[0]!, inbound, "post-reconnect inbound changed");
    });

    await check("close_failed", async () => {
      let removedStatusCalls = 0;
      const remove = transport.onStatus(() => { removedStatusCalls++; });
      remove();
      transport.close();
      await waitUntil(() => transport.status === "closed", timeoutMs, "close did not reach 'closed'");
      assert(statuses.some(({ status }) => status === "closed"), "close did not publish 'closed'");
      await nextTurn();
      assert(transport.status === "closed", "caller close restarted the transport");
      assert(removedStatusCalls === 0, "an unsubscribed status listener was called");
    });
  } finally {
    unsubscribeMessage();
    unsubscribeStatus();
    try {
      await harness.dispose?.();
    } catch (cause) {
      add("fixture_failed", describeFailure("fixture cleanup failed", cause));
    }
  }

  return freezeReport(checksRun, issues);
};

const envelope = (sequence: number): RoomEnvelope => ({
  roomId: "transport-conformance",
  hostEpoch: 7,
  sequence,
  tick: sequence,
  senderClientId: "conformance-peer",
  heartbeat: {
    sentAtUnixMs: sequence,
    simulationHz: 60,
    workerDriftMs: 0,
    pageVisible: true,
  },
});

const assertTrafficShape = (traffic: TransportTraffic): void => {
  for (const [name, value] of Object.entries({
    inboundBytes: traffic.inboundBytes,
    outboundBytes: traffic.outboundBytes,
    inboundMessages: traffic.inboundMessages,
    outboundMessages: traffic.outboundMessages,
    droppedOutbound: traffic.droppedOutbound,
  })) {
    assert(Number.isInteger(value) && value >= 0, `${name} must be a non-negative integer`);
  }
};

const assertEnvelope = (actual: RoomEnvelope, expected: RoomEnvelope, message: string): void => {
  const actualBytes = encodeEnvelope(actual);
  const expectedBytes = encodeEnvelope(expected);
  assert(
    actualBytes.length === expectedBytes.length &&
      actualBytes.every((byte, index) => byte === expectedBytes[index]),
    message,
  );
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const waitUntil = async (
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await nextTurn();
  }
};

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const describeFailure = (prefix: string, cause: unknown): string =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`;

const freezeReport = (
  checksRun: number,
  issues: RoomTransportConformanceIssue[],
): Readonly<RoomTransportConformanceReport> => Object.freeze({
  ok: issues.length === 0,
  checksRun,
  issues: Object.freeze(issues),
});
