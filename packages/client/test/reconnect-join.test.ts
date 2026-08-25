import { describe, expect, it } from "vitest";
import { emptySnapshot, type CanvasSnapshot } from "@canvas-physics/core";
import {
  DurableCommandKind,
  fromJsonBytes,
  toJsonBytes,
  type Peer,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import { RoomClient } from "../src/net/room-client.js";
import { RoomSession } from "../src/runtime/room-session.js";
import { rocketCanvas, rocketCanvasDefinitions } from "../src/definitions/rocket-canvas.js";
import { SimulationDriver } from "../src/simulation/driver.js";
import type { SimulationRequest } from "../src/simulation/messages.js";
import {
  emptyTraffic,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/net/transport.js";

class ReconnectTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  readonly sent: RoomEnvelope[] = [];
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(
    status: TransportStatus,
    detail?: string,
  ) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {
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

describe("RoomClient reconnect handshake", () => {
  it("rate-limits preview moves and sends the final transform immediately", async () => {
    const transport = new ReconnectTransport();
    const driver = new SimulationDriver(() => ({
      send: () => {},
      terminate: () => {},
    }));
    const session = new RoomSession({
      transport,
      driver,
      roomId: rocketCanvas.id,
      serverUrl: "http://localhost:8080",
      definitions: rocketCanvasDefinitions,
      rates: { previewHz: 10 },
    });
    const transform = (x: number) => ({ x, y: 20, rotation: 0 });
    const sentMoves = () =>
      transport.sent
        .map((message) => message.durableCommand)
        .filter(
          (command) => command?.kind === DurableCommandKind.DURABLE_MOVE_ITEM,
        );

    session.moveItem("item-1", transform(1), true);
    session.moveItem("item-1", transform(2), true);
    session.moveItem("item-1", transform(3), true);

    expect(sentMoves()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(sentMoves()).toHaveLength(2);
    expect(sentMoves()[1]?.position?.x).toBe(3);

    session.moveItem("item-1", transform(4), true);
    session.moveItem("item-1", transform(5));
    expect(sentMoves().at(-1)).toMatchObject({ preview: false, position: { x: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sentMoves()).toHaveLength(3);
    session.stop();
  });

  it("resends JOIN and drops a stale host role before reconnecting", async () => {
    const transport = new ReconnectTransport();
    const client = new RoomClient({
      transport,
      heartbeatHz: 1000,
      definitions: [{ definitionId: "rocket", version: 1 }],
      join: {
        roomId: "rocket-canvas",
        serverUrl: "http://localhost:8080",
      },
    });

    await client.connect();
    expect(transport.sent.filter((message) => message.join).length).toBe(1);

    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 7,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "c-old",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 7,
        hostClientId: "c-old",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    const staleLease = client.hostLease;
    expect(Object.isFrozen(client.connectionIdentity)).toBe(true);
    expect(Object.isFrozen(staleLease)).toBe(true);
    const hostChanges: string[] = [];
    client.on("hostChanged", (_lease, reason) => hostChanges.push(reason));

    transport.setStatus("reconnecting", "connection dropped");
    expect(client.hostLease.isHost).toBe(false);
    expect(Object.isFrozen(client.hostLease)).toBe(true);
    expect(hostChanges).toEqual(["transport_lost"]);
    const beforeStaleYield = transport.sent.length;
    client.yieldHost("stale callback", staleLease);
    expect(transport.sent).toHaveLength(beforeStaleYield);

    transport.setStatus("open");
    expect(transport.sent.filter((message) => message.join).length).toBe(2);
    client.close();
  });

  it("retains the stable local avatar identity across a reconnected socket", async () => {
    const transport = new ReconnectTransport();
    const requests: SimulationRequest[] = [];
    const driver = new SimulationDriver(() => ({
      send: (request) => requests.push(request),
      terminate: () => {},
    }));
    const session = new RoomSession({
      transport,
      driver,
      roomId: rocketCanvas.id,
      serverUrl: "http://localhost:8080",
      definitions: rocketCanvasDefinitions,
    });

    await session.start();
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 1,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "c-first",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 1,
        hostClientId: "c-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    await Promise.resolve();
    expect(session.avatarId).toBe("avatar:alice");

    transport.setStatus("reconnecting");
    transport.setStatus("open");
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 2,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "c-second",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 2,
        hostClientId: "c-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    await Promise.resolve();

    expect(session.avatarId).toBe("avatar:alice");
    expect(requests).not.toContainEqual({ type: "removeAvatar", entityId: "avatar:alice" });
    session.stop();
  });

  it("reconciles host avatars from presence without duplicating the local avatar", async () => {
    const transport = new ReconnectTransport();
    const requests: SimulationRequest[] = [];
    let postFromSimulation:
      | ((message: Parameters<Parameters<SimulationDriver["onMessage"]>[0]>[0]) => void)
      | undefined;
    const driver = new SimulationDriver((post) => {
      postFromSimulation = post;
      return {
        send: (request) => requests.push(request),
        terminate: () => {},
      };
    });
    const session = new RoomSession({
      transport,
      driver,
      roomId: rocketCanvas.id,
      serverUrl: "http://localhost:8080",
      definitions: rocketCanvasDefinitions,
      projectParticipantAvatar: (participant) =>
        participant.status !== "active"
          ? { position: { x: 50, y: 60 } }
          : undefined,
    });

    await session.start();
    const snapshot = emptySnapshot(rocketCanvas.id, rocketCanvas.version);
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "c-host",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 3,
        hostClientId: "c-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(snapshot),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    await Promise.resolve();

    const peer = (clientId: string, userId: string, isHost: boolean): Peer => ({
      clientId,
      userId,
      displayName: userId,
      isHost,
      hostEligible: true,
    });
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      presence: { peers: [peer("c-host", "alice", true), peer("c-peer", "bob", false)] },
    });
    postFromSimulation?.({ type: "ready", generation: 1 });

    expect(
      requests
        .filter((request) => request.type === "addAvatar")
        .map((request) => request.spawn.entityId),
    ).toEqual(["avatar:bob"]);

    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "c-peer",
      playerInput: {
        inputSequence: 1,
        direction: { x: 0, y: 0 },
        intensity: 0,
        clientTimeUnixMs: 0,
        held: false,
        avatarDisabled: true,
      },
    });
    expect(requests).toContainEqual({
      type: "setAvatarLifecycle",
      entityId: "avatar:bob",
      disabled: true,
      position: { x: 50, y: 60 },
    });

    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      presence: { peers: [peer("c-host", "alice", true)] },
    });
    expect(requests).not.toContainEqual({ type: "removeAvatar", entityId: "avatar:bob" });
    expect(requests).toContainEqual({
      type: "setAvatarLifecycle",
      entityId: "avatar:bob",
      disabled: true,
      position: { x: 50, y: 60 },
    });
    session.stop();
  });

  it("sends a normalized final checkpoint before the last host closes", async () => {
    const transport = new ReconnectTransport();
    const snapshot = emptySnapshot(rocketCanvas.id, rocketCanvas.version);
    let postFromSimulation:
      | ((message: Parameters<Parameters<SimulationDriver["onMessage"]>[0]>[0]) => void)
      | undefined;
    const driver = new SimulationDriver((post) => {
      postFromSimulation = post;
      return {
        send: (request) => {
          if (request.type !== "requestSnapshot" || !request.final) return;
          post({
            type: "snapshot",
            generation: request.generation,
            final: true,
            snapshot: {
              ...snapshot,
              sceneRevision: request.sceneRevision,
              hostEpoch: request.hostEpoch,
              checkpointRevision: 1,
              normalized: true,
            },
          });
        },
        terminate: () => {},
      };
    });
    const session = new RoomSession({
      transport,
      driver,
      roomId: rocketCanvas.id,
      serverUrl: "http://localhost:8080",
      definitions: rocketCanvasDefinitions,
    });

    await session.start();
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "c-host",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 3,
        hostClientId: "c-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(snapshot),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    await Promise.resolve();
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      presence: {
        peers: [
          {
            clientId: "c-host",
            userId: "alice",
            displayName: "Alice",
            isHost: true,
            hostEligible: true,
          },
        ],
      },
    });
    // The real worker reports readiness after it has rebuilt the host world.
    postFromSimulation?.({ type: "ready", generation: 1 });

    await session.stopGracefully(1_000);

    const final = transport.sent.find((message) => message.checkpoint?.final);
    expect(final).toBeDefined();
    expect(final?.checkpoint?.checkpointRevision).toBe(1);
    expect(
      fromJsonBytes<CanvasSnapshot>(final!.checkpoint!.snapshotJson)?.normalized,
    ).toBe(true);
    expect(transport.status).toBe("closed");
  });
});
