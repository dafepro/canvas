import { describe, expect, it, vi } from "vitest";
import { emptySnapshot, type ItemDefinition } from "@canvas-physics/core";
import {
  HostControlKind,
  toJsonBytes,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
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
  type RuntimeStartupSnapshot,
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
    spawnPointId?: string;
    definitions?: ItemDefinition[];
  } = {},
) => {
  const terminate = vi.fn();
  const send = vi.fn();
  const driver = new SimulationDriver(() => ({ send, terminate }));
  const session = new RoomSession({
    roomId: "team-lounge",
    serverUrl: "http://rooms.test",
    definitions: options.definitions ?? rocketCanvasDefinitions,
    transport,
    driver,
    spawnPointId: options.spawnPointId,
    onError: options.onError,
    onJoined: options.onJoined,
  });
  return { session, send, terminate };
};

describe("RoomSession lifecycle", () => {
  it("publishes truthful startup milestones through canonical presentation", async () => {
    const transport = new LifecycleTransport();
    let postFromSimulation:
      | ((message: Parameters<Parameters<SimulationDriver["onMessage"]>[0]>[0]) => void)
      | undefined;
    const requests: unknown[] = [];
    const driver = new SimulationDriver((post) => {
      postFromSimulation = post;
      return {
        send: (request) => requests.push(request),
        terminate: () => {},
      };
    });
    const session = new RoomSession({
      roomId: "team-lounge",
      serverUrl: "http://rooms.test",
      definitions: rocketCanvasDefinitions,
      transport,
      driver,
    });
    const startup: RuntimeStartupSnapshot[] = [];
    session.subscribeStartup((snapshot) => startup.push(snapshot));

    await session.start();
    expect(startup.map(({ phase }) => phase)).toEqual([
      "credentials",
      "connecting",
      "joining",
    ]);

    transport.deliver(accepted("peer"));
    await session.whenReady();
    expect(startup.at(-1)?.phase).toBe("simulation");
    const generation = (requests.find(
      (request) => (request as { type?: string }).type === "init",
    ) as { generation: number }).generation;
    postFromSimulation?.({ type: "ready", generation });
    expect(startup.at(-1)?.phase).toBe("canonical");

    transport.deliver({
      roomId: "team-lounge",
      hostEpoch: 1,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      presence: { peers: [] },
    });
    transport.deliver({
      roomId: "team-lounge",
      hostEpoch: 1,
      sequence: 0,
      tick: 1,
      senderClientId: "",
      fullState: {
        entities: [],
        avatars: [],
        sceneRevision: 0,
        tickRate: 60,
      },
    });
    await session.whenPresented();
    expect(startup.map(({ phase }) => phase)).toEqual([
      "credentials",
      "connecting",
      "joining",
      "simulation",
      "canonical",
      "presenting",
      "ready",
    ]);

    transport.setStatus("reconnecting", "network changed");
    transport.setStatus("open");
    expect(startup.at(-1)?.phase).toBe("ready");
    expect(startup).toHaveLength(7);
    session.stop();
    expect(startup.at(-1)?.phase).toBe("ready");
  });

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
    expect(session.startupSnapshot).toMatchObject({
      phase: "cancelled",
      error: { code: "start_cancelled" },
    });
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
    expect(failed.session.startupSnapshot).toMatchObject({
      phase: "failed",
      error: { code: "transport_connection_failed" },
    });
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

  it("does not reveal a reconnect while the one-time room initialization is pending", async () => {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const transport = new LifecycleTransport();
    const { session, send } = build(transport, {
      onJoined: () => initialization,
    });

    await session.start();
    const ready = session.whenReady();
    transport.deliver(accepted("first"));
    transport.setStatus("reconnecting", "socket replaced during initialization");
    transport.setStatus("open");
    transport.deliver(accepted("second"));
    await Promise.resolve();
    await Promise.resolve();

    expect(session.lifecycleState).toBe("joining");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "init" }));

    finishInitialization();
    await ready;
    expect(session.lifecycleState).toBe("active");
    expect(
      send.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "init"),
    ).toHaveLength(1);
    session.stop();
  });

  it("ignores simulation responses from an obsolete role generation", async () => {
    const transport = new LifecycleTransport();
    let postFromSimulation:
      | ((message: Parameters<Parameters<SimulationDriver["onMessage"]>[0]>[0]) => void)
      | undefined;
    const requests: unknown[] = [];
    const driver = new SimulationDriver((post) => {
      postFromSimulation = post;
      return {
        send: (request) => requests.push(request),
        terminate: () => {},
      };
    });
    const session = new RoomSession({
      roomId: "team-lounge",
      serverUrl: "http://rooms.test",
      definitions: rocketCanvasDefinitions,
      transport,
      driver,
    });

    await session.start();
    transport.deliver(accepted("peer"));
    await session.whenReady();
    const initialGeneration = (requests.find(
      (request) => (request as { type?: string }).type === "init",
    ) as { generation?: number } | undefined)?.generation;
    expect(initialGeneration).toBeTypeOf("number");

    transport.deliver({
      roomId: "team-lounge",
      hostEpoch: 2,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      hostControl: {
        kind: HostControlKind.HOST_CONTROL_GRANTED,
        hostClientId: "peer",
        hostEpoch: 2,
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        reason: "host_timeout",
        eligible: true,
        leaseExpiresAtUnixMs: 0,
      },
    });
    const promotedGeneration = (requests.findLast(
      (request) => (request as { type?: string }).type === "setHost",
    ) as { generation?: number } | undefined)?.generation;
    expect(promotedGeneration).toBeTypeOf("number");
    expect(promotedGeneration).not.toBe(initialGeneration);

    const stats = {
      hz: 60,
      driftMs: 0,
      worstStepMs: 0,
      awakeBodies: 0,
      behaviorErrors: 0,
      activeColliders: 0,
    };
    postFromSimulation?.({
      type: "render",
      generation: initialGeneration,
      tick: 999,
      isHost: false,
      entities: [],
      stats,
    } as Parameters<NonNullable<typeof postFromSimulation>>[0]);
    expect(session.tick).toBe(0);

    postFromSimulation?.({
      type: "render",
      generation: promotedGeneration,
      tick: 12,
      isHost: true,
      entities: [],
      stats,
    } as Parameters<NonNullable<typeof postFromSimulation>>[0]);
    expect(session.tick).toBe(12);
    expect(session.diagnostics().staleSimulationResponses).toBe(1);
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

  it("keeps a peer active when only host definition eligibility is refused", async () => {
    const transport = new LifecycleTransport();
    const errors: CanvasConsumerError[] = [];
    const { session } = build(transport, { onError: (error) => errors.push(error) });
    await session.start();
    transport.deliver(accepted());
    await session.whenReady();

    transport.deliver({
      roomId: "team-lounge",
      hostEpoch: 1,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      error: {
        code: "definition_mismatch",
        message: "the client lacks rocket@1",
        serverProtocolVersion: 0,
      },
    });

    expect(session.lifecycleState).toBe("active");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "server_rejected",
      source: "protocol",
      recoverable: true,
      details: { serverCode: "definition_mismatch" },
    });
    session.stop();
  });

  it("rejects malformed and unsupported join data through typed errors", async () => {
    const malformedTransport = new LifecycleTransport();
    const malformed = build(malformedTransport).session;
    await malformed.start();
    const malformedReady = malformed.whenReady();
    const malformedJoin = accepted();
    malformedJoin.joinAccepted!.canvasDefinitionJson = new TextEncoder().encode("{");

    expect(() => malformedTransport.deliver(malformedJoin)).not.toThrow();
    await expect(malformedReady).rejects.toMatchObject({
      code: "server_rejected",
      source: "protocol",
      details: { serverCode: "malformed_join" },
    });

    const unsupportedTransport = new LifecycleTransport();
    const unsupported = build(unsupportedTransport).session;
    await unsupported.start();
    const unsupportedReady = unsupported.whenReady();
    const unsupportedJoin = accepted();
    unsupportedJoin.joinAccepted!.snapshotJson = toJsonBytes({
      ...emptySnapshot(rocketCanvas.id, rocketCanvas.version),
      schemaVersion: 2,
    });
    unsupportedTransport.deliver(unsupportedJoin);

    await expect(unsupportedReady).rejects.toMatchObject({
      code: "join_initialization_failed",
      source: "initialization",
    });
  });

  it("rejects a duplicate definition bundle before initializing simulation", async () => {
    const transport = new LifecycleTransport();
    const duplicate = {
      ...rocketCanvasDefinitions[0]!,
      version: rocketCanvasDefinitions[0]!.version + 1,
    };
    const { session, send } = build(transport, {
      definitions: [...rocketCanvasDefinitions, duplicate],
    });
    await session.start();
    const ready = session.whenReady();
    transport.deliver(accepted());

    await expect(ready).rejects.toMatchObject({
      code: "join_initialization_failed",
      source: "initialization",
      message: expect.stringContaining("duplicate item definition"),
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "init" }));
  });

  it("uses a requested arrival spawn and rejects an unknown one", async () => {
    const transport = new LifecycleTransport();
    const { session, send } = build(transport, { spawnPointId: "pad" });
    await session.start();
    transport.deliver(accepted());
    await session.whenReady();

    const init = send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "init");
    expect(init?.localAvatar?.position.y).toBe(62);
    expect(init?.localAvatar?.position.x).toBeGreaterThan(69.5);
    expect(init?.localAvatar?.position.x).toBeLessThan(70.5);
    session.stop();

    const invalidTransport = new LifecycleTransport();
    const invalid = build(invalidTransport, { spawnPointId: "missing" }).session;
    await invalid.start();
    const ready = invalid.whenReady();
    invalidTransport.deliver(accepted());
    await expect(ready).rejects.toMatchObject({ code: "join_initialization_failed" });
    expect(invalid.lifecycleState).toBe("failed");
  });
});
