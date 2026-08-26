import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import { toJsonBytes, type RoomEnvelope } from "@canvas-physics/protocol";
import {
  emptyTraffic,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/net/transport.js";
import { rocketCanvas, rocketCanvasDefinitions } from "../src/definitions/rocket-canvas.js";
import { RoomSession } from "../src/runtime/room-session.js";
import { SimulationDriver } from "../src/simulation/driver.js";

class SignalTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  readonly reliable: RoomEnvelope[] = [];
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {
    this.status = "open";
    for (const listener of this.statuses) listener("open");
  }

  sendReliable(message: RoomEnvelope): void {
    this.reliable.push(message);
  }

  sendRealtime(): void {}

  onMessage(listener: (message: RoomEnvelope) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }

  close(): void {
    this.status = "closed";
  }

  deliver(message: RoomEnvelope): void {
    for (const listener of this.messages) listener(message);
  }
}

const envelope = (payload: Partial<RoomEnvelope>): RoomEnvelope => ({
  roomId: rocketCanvas.id,
  hostEpoch: 1,
  sequence: 0,
  tick: 0,
  senderClientId: "",
  ...payload,
});

describe("participant signals", () => {
  it("publishes only server-attributed signals from authenticated participants", async () => {
    const transport = new SignalTransport();
    const session = new RoomSession({
      transport,
      driver: new SimulationDriver(() => ({ send: () => {}, terminate: () => {} })),
      roomId: rocketCanvas.id,
      serverUrl: "http://rooms.test",
      definitions: rocketCanvasDefinitions,
    });
    const observer = vi.fn();
    session.subscribeParticipantSignals(observer);

    await session.start();
    transport.deliver(envelope({
      joinAccepted: {
        clientId: "client-alice",
        userId: "alice",
        displayName: "Alice",
        sceneRevision: 0,
        hostEpoch: 1,
        hostClientId: "client-alice",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
        canvasId: rocketCanvas.id,
      },
    }));
    transport.deliver(envelope({
      presence: {
        peers: [
          {
            clientId: "client-alice",
            userId: "alice",
            displayName: "Alice",
            isHost: true,
            hostEligible: true,
          },
          {
            clientId: "client-bob",
            userId: "bob",
            displayName: "Bob",
            isHost: false,
            hostEligible: true,
          },
        ],
      },
    }));

    session.sendParticipantSignal("zoomigo.emote.wave");
    expect(transport.reliable.at(-1)).toMatchObject({
      participantSignal: {
        kind: "zoomigo.emote.wave",
        paramsJson: new Uint8Array(),
      },
    });

    transport.deliver(envelope({
      senderClientId: "client-bob",
      participantSignal: {
        kind: "zoomigo.emote.star",
        paramsJson: toJsonBytes({ source: "button" }),
      },
    }));
    expect(observer).toHaveBeenCalledWith({
      participantId: "bob",
      kind: "zoomigo.emote.star",
      params: { source: "button" },
    });

    transport.deliver(envelope({
      senderClientId: "spoofed-client",
      participantSignal: {
        kind: "zoomigo.emote.wave",
        paramsJson: new Uint8Array(),
      },
    }));
    expect(observer).toHaveBeenCalledTimes(1);
    session.stop();
  });
});
