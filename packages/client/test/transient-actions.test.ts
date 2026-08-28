import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import {
  TransientActionRejectCode,
  TransientActionTargetKind,
  toJsonBytes,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import {
  RoomClient,
  RoomSession,
  SimulationDriver,
  emptyTraffic,
  rocketCanvas,
  rocketCanvasDefinitions,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/index.js";
import type { SimulationRequest } from "../src/simulation/messages.js";

class TransientTransport implements RoomTransport {
  readonly sent: RoomEnvelope[] = [];
  readonly traffic = emptyTraffic();
  status: TransportStatus = "open";
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(status: TransportStatus, detail?: string) => void>();

  connect(_join: JoinDescriptor): Promise<void> {
    this.setStatus("open");
    return Promise.resolve();
  }
  sendReliable(message: RoomEnvelope): void {
    this.sent.push(message);
  }
  sendEphemeralReliable(message: RoomEnvelope): boolean {
    if (this.status !== "open") return false;
    this.sent.push(message);
    return true;
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
    this.status = "closed";
  }
  deliver(message: RoomEnvelope): void {
    for (const handler of this.messages) handler(message);
  }
  setStatus(status: TransportStatus): void {
    this.status = status;
    for (const handler of this.statuses) handler(status);
  }
}

const clientWith = (transport: TransientTransport): RoomClient => new RoomClient({
  transport,
  join: { roomId: "room", serverUrl: "http://127.0.0.1:1" },
  heartbeatHz: 0.001,
});

describe("transient room actions", () => {
  it("uses current-connection reliable delivery and resolves the stable result", async () => {
    const transport = new TransientTransport();
    const client = clientWith(transport);
    const receipt = client.submitTransientAction({
      action: "rocket.launch",
      target: "item",
      entityId: "item-1",
      payload: { power: 2 },
    });
    const outbound = transport.sent.at(-1)?.transientAction;
    expect(outbound).toMatchObject({
      requestId: receipt.requestId,
      clientSessionId: receipt.clientSessionId,
      action: "rocket.launch",
      targetKind: TransientActionTargetKind.TRANSIENT_ACTION_TARGET_ITEM,
      entityId: "item-1",
      participantId: "",
      dispatchEntityId: "",
    });

    transport.deliver({
      roomId: "room",
      hostEpoch: 0,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      transientActionResult: {
        clientSessionId: receipt.clientSessionId,
        requestId: receipt.requestId,
        accepted: true,
        rejectCode: TransientActionRejectCode.TRANSIENT_ACTION_REJECT_UNSPECIFIED,
        message: "",
        action: "rocket.launch",
        targetKind: TransientActionTargetKind.TRANSIENT_ACTION_TARGET_ITEM,
        entityId: "item-1",
      },
    });
    await expect(receipt.result).resolves.toMatchObject({ accepted: true });
    client.close();
  });

  it("does not queue or replay an action across reconnect", async () => {
    const transport = new TransientTransport();
    const client = clientWith(transport);
    const receipt = client.submitTransientAction({ action: "round.restart", target: "room" });
    expect(transport.sent.filter((message) => message.transientAction)).toHaveLength(1);

    transport.setStatus("reconnecting");
    await expect(receipt.result).resolves.toMatchObject({
      accepted: false,
      rejectCode: TransientActionRejectCode.TRANSIENT_ACTION_REJECT_STALE,
    });
    transport.setStatus("open");
    expect(transport.sent.filter((message) => message.transientAction)).toHaveLength(1);
    client.close();
  });

  it("accepts only server-authored host dispatch on the current epoch", () => {
    const transport = new TransientTransport();
    const client = clientWith(transport);
    const received: unknown[] = [];
    client.on("transientAction", (action) => received.push({
      ...action,
      payload: JSON.parse(new TextDecoder().decode(action.payloadJson)),
    }));
    transport.deliver({
      roomId: "room",
      hostEpoch: 0,
      sequence: 0,
      tick: 0,
      senderClientId: "peer-1",
      transientAction: {
        clientSessionId: "session",
        requestId: 1,
        action: "rocket.launch",
        targetKind: TransientActionTargetKind.TRANSIENT_ACTION_TARGET_ITEM,
        entityId: "item-1",
        payloadJson: toJsonBytes({ power: 2 }),
        participantId: "alice",
        dispatchEntityId: "item-1",
      },
    });
    expect(received).toEqual([expect.objectContaining({
      participantId: "alice",
      dispatchEntityId: "item-1",
      payload: { power: 2 },
    })]);
    client.close();
  });

  it("delivers the authenticated payload to the active host behavior boundary", async () => {
    const transport = new TransientTransport();
    const requests: SimulationRequest[] = [];
    const driver = new SimulationDriver(() => ({
      send: (request) => requests.push(request),
      terminate: () => {},
    }));
    const session = new RoomSession({
      roomId: rocketCanvas.id,
      serverUrl: "http://127.0.0.1:1",
      definitions: rocketCanvasDefinitions,
      transport,
      driver,
    });
    await session.start();
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "host-1",
        userId: "host-user",
        displayName: "Host",
        sceneRevision: 0,
        hostEpoch: 3,
        hostClientId: "host-1",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
        canvasId: rocketCanvas.id,
      },
    });
    await session.whenReady();
    transport.deliver({
      roomId: rocketCanvas.id,
      hostEpoch: 3,
      sequence: 0,
      tick: 0,
      senderClientId: "peer-1",
      transientAction: {
        clientSessionId: "peer-session",
        requestId: 7,
        action: "rocket.launch",
        targetKind: TransientActionTargetKind.TRANSIENT_ACTION_TARGET_ITEM,
        entityId: "item-1",
        payloadJson: toJsonBytes({ power: 2 }),
        participantId: "alice",
        dispatchEntityId: "item-1",
      },
    });
    expect(requests).toContainEqual({
      type: "ownerAction",
      entityId: "item-1",
      action: "rocket.launch",
      userId: "alice",
      payload: { power: 2 },
    });
    session.stop();
  });
});
