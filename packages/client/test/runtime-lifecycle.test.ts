import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import { toJsonBytes, type RoomEnvelope } from "@canvas-physics/protocol";
import {
  CanvasConsumerError,
  RoomSession,
  SimulationDriver,
  emptyTraffic,
  rocketCanvas,
  rocketCanvasDefinitions,
  type CanvasLifecycleSnapshot,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/index.js";

class LifecycleTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  readonly sent: RoomEnvelope[] = [];
  connectCalls = 0;
  connectError?: Error;
  connectGate?: Promise<void>;
  closeCalls = 0;
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(
    status: TransportStatus,
    detail?: string,
  ) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {
    this.connectCalls++;
    if (this.connectError) throw this.connectError;
    if (this.connectGate) await this.connectGate;
    this.setStatus("open");
  }

  sendReliable(message: RoomEnvelope): void {
    this.sent.push(message);
  }
  sendRealtime(message: RoomEnvelope): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: RoomEnvelope) => void): () => void {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }
  onStatus(handler: (status: TransportStatus, detail?: string) => void): () => void {
    this.statuses.add(handler);
    return () => this.statuses.delete(handler);
  }
  close(): void {
    this.closeCalls++;
    this.setStatus("closed");
  }
  setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    for (const handler of this.statuses) handler(status, detail);
  }
  deliver(message: RoomEnvelope): void {
    for (const handler of this.messages) handler(message);
  }
}

const accepted = (clientId = "client-1"): RoomEnvelope => ({
  roomId: "team-lounge",
  hostEpoch: 1,
  sequence: 0,
  tick: 0,
  senderClientId: "",
  joinAccepted: {
    clientId,
    userId: "alice",
    displayName: "Alice",
    sceneRevision: 0,
    hostEpoch: 1,
    hostClientId: "other-host",
    canvasDefinitionJson: toJsonBytes(rocketCanvas),
    snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
    roomWasSleeping: false,
    tickRate: 60,
    canvasId: rocketCanvas.id,
  },
});

const build = (
  transport: LifecycleTransport,
  options: {
    onError?: (error: CanvasConsumerError) => void;
    onJoined?: () => void | Promise<void>;
  } = {},
) => {
  const terminate = vi.fn();
  const driver = new SimulationDriver(() => ({ send: vi.fn(), terminate }));
  const session = new RoomSession({
    roomId: "team-lounge",
    serverUrl: "http://rooms.test",
    definitions: rocketCanvasDefinitions,
    transport,
    driver,
    onError: options.onError,
    onJoined: options.onJoined,
  });
  return { session, terminate };
};

describe("RoomSession lifecycle", () => {
  it("publishes deterministic join, background, and terminal stop states", async () => {
    const transport = new LifecycleTransport();
    const { session, terminate } = build(transport);
    const seen: CanvasLifecycleSnapshot[] = [];
    session.subscribeLifecycle((snapshot) => seen.push(snapshot));

    await session.start();
    expect(session.lifecycleState).toBe("joining");
    transport.deliver(accepted());
    await session.whenReady();
    expect(session.lifecycleState).toBe("active");

    session.setPageVisible(false);
    expect(session.lifecycleState).toBe("backgrounded");
    session.setPageVisible(true);
    expect(session.lifecycleState).toBe("active");

    session.stop();
    session.stop();
    expect(session.lifecycleState).toBe("stopped");
    expect(terminate).toHaveBeenCalledOnce();
    expect(transport.closeCalls).toBe(1);
    expect(seen.map(({ state }) => state)).toEqual([
      "idle",
      "starting",
      "joining",
      "active",
      "backgrounded",
      "active",
      "stopping",
      "stopped",
    ]);
    await expect(session.start()).rejects.toMatchObject({
      code: "invalid_lifecycle_state",
    });
  });

  it("coalesces concurrent starts and rejects a start cancelled by unmount", async () => {
    let release!: () => void;
    const transport = new LifecycleTransport();
    transport.connectGate = new Promise<void>((resolve) => { release = resolve; });
    const { session } = build(transport);

    const first = session.start();
    const second = session.start();
    expect(second).toBe(first);
    expect(transport.connectCalls).toBe(1);
    session.stop();
    release();

    await expect(first).rejects.toMatchObject({ code: "start_cancelled" });
    expect(session.lifecycleState).toBe("stopped");
  });

  it("reports connection and server failures as typed consumer errors", async () => {
    const connectionErrors: CanvasConsumerError[] = [];
    const failedTransport = new LifecycleTransport();
    failedTransport.connectError = new Error("ticket unavailable");
    const failed = build(failedTransport, { onError: (error) => connectionErrors.push(error) });

    await expect(failed.session.start()).rejects.toMatchObject({
      code: "transport_connection_failed",
      source: "transport",
      recoverable: false,
    });
    expect(failed.session.lifecycleState).toBe("failed");
    expect(connectionErrors).toHaveLength(1);
    failed.session.stop();
    expect(failed.session.lifecycleState).toBe("failed");

    const protocolErrors: CanvasConsumerError[] = [];
    const transport = new LifecycleTransport();
    const { session } = build(transport, { onError: (error) => protocolErrors.push(error) });
    await session.start();
    const ready = session.whenReady();
    transport.deliver({
      roomId: "team-lounge",
      hostEpoch: 0,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      error: {
        code: "room_template_conflict",
        message: "template changed",
        serverProtocolVersion: 0,
      },
    });
    await expect(ready).rejects.toMatchObject({
      code: "server_rejected",
      source: "protocol",
      details: { serverCode: "room_template_conflict" },
    });
    expect(session.lifecycleState).toBe("failed");
    expect(protocolErrors).toHaveLength(1);
    session.stop();
  });

  it("moves through reconnecting and joining before becoming active again", async () => {
    const transport = new LifecycleTransport();
    const { session } = build(transport);
    await session.start();
    transport.deliver(accepted("first"));
    await session.whenReady();

    transport.setStatus("reconnecting", "network changed");
    expect(session.lifecycleState).toBe("reconnecting");
    transport.setStatus("open");
    expect(session.lifecycleState).toBe("joining");
    transport.deliver(accepted("second"));
    await vi.waitFor(() => expect(session.lifecycleState).toBe("active"));
    session.stop();
  });

  it("turns consumer initialization failures into terminal typed errors", async () => {
    const transport = new LifecycleTransport();
    const onError = vi.fn();
    const { session, terminate } = build(transport, {
      onJoined: async () => { throw new Error("scene mount failed"); },
      onError,
    });

    await session.start();
    const ready = session.whenReady();
    transport.deliver(accepted());

    await expect(ready).rejects.toMatchObject({
      code: "join_initialization_failed",
      source: "initialization",
      cause: expect.any(Error),
    });
    expect(session.lifecycleState).toBe("failed");
    expect(terminate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    session.stop();
  });
});
