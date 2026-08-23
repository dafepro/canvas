import { describe, expect, it } from "vitest";
import { emptySnapshot, type EffectEmission } from "@canvas-physics/core";
import {
  toJsonBytes,
  type Peer,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import { emptyTraffic, type JoinDescriptor, type RoomTransport, type TransportStatus } from "../src/net/transport.js";
import {
  RoomSession,
  type BehaviorStateSnapshot,
  type CanonicalStateSnapshot,
  type PresenceSnapshot,
} from "../src/runtime/room-session.js";
import { SimulationDriver } from "../src/simulation/driver.js";
import { rocketCanvas, rocketCanvasDefinitions } from "../src/definitions/rocket-canvas.js";

class ObserverTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {
    this.status = "open";
    for (const listener of this.statuses) listener("open");
  }

  sendReliable(): void {}
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

describe("RoomSession observers", () => {
  it("replays immutable authenticated presence and complete canonical state", async () => {
    const transport = new ObserverTransport();
    const driver = new SimulationDriver(() => ({ send: () => {}, terminate: () => {} }));
    const session = new RoomSession({
      transport,
      driver,
      canvasId: rocketCanvas.id,
      serverUrl: "http://rooms.test",
      definitions: rocketCanvasDefinitions,
    });
    const presence: PresenceSnapshot[] = [];
    const canonical: CanonicalStateSnapshot[] = [];
    const behavior: BehaviorStateSnapshot[] = [];
    const effects: Readonly<EffectEmission>[] = [];
    session.subscribePresence((snapshot) => presence.push(snapshot));
    session.subscribeCanonicalState((snapshot) => canonical.push(snapshot));
    session.subscribeBehaviorState((snapshot) => behavior.push(snapshot));
    session.subscribeEffects((effect) => effects.push(effect));

    await session.start();
    transport.deliver(envelope({
      joinAccepted: {
        clientId: "client-1",
        userId: "user-1",
        displayName: "Authenticated User",
        sceneRevision: 3,
        hostEpoch: 1,
        hostClientId: "other-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
      },
    }));
    const peer: Peer = {
      clientId: "client-1",
      userId: "user-1",
      displayName: "Authenticated User",
      isHost: false,
      hostEligible: true,
    };
    transport.deliver(envelope({ presence: { peers: [peer] } }));
    transport.deliver(envelope({
      tick: 10,
      fullState: {
        sceneRevision: 3,
        tickRate: 60,
        avatars: [],
        entities: [{
          entityId: "ball-1",
          quantizedTransform: {
            x: 100,
            y: 200,
            rotation: 0,
            vx: 0,
            vy: 0,
            angularVelocity: 0,
            z: 0,
            vz: 0,
          },
          lastProcessedInputSequence: 0,
          spriteVariant: "live",
          spriteAnimation: "hardKick",
          animationEpoch: 7,
          behaviorStateJson: toJsonBytes({ score: 1 }),
          quarantined: false,
          definitionId: "ball",
          disabled: false,
          teleportEpoch: 0,
          respawning: false,
        }],
      },
    }));
    transport.deliver(envelope({
      tick: 11,
      stateDelta: {
        sceneRevision: 3,
        removedEntityIds: [],
        entities: [{
          entityId: "ball-1",
          quantizedTransform: {
            x: 150,
            y: 200,
            rotation: 0,
            vx: 0,
            vy: 0,
            angularVelocity: 0,
            z: 0,
            vz: 0,
          },
          lastProcessedInputSequence: 0,
          spriteVariant: "live",
          spriteAnimation: "hardKick",
          animationEpoch: 7,
          behaviorStateJson: new Uint8Array(),
          quarantined: false,
          definitionId: "",
          disabled: false,
          teleportEpoch: 0,
          respawning: false,
        }],
      },
    }));
    transport.deliver(envelope({
      tick: 11,
      effectEvent: {
        entityId: "ball-1",
        effect: "goal",
        mode: "oneShot",
        paramsJson: toJsonBytes({ team: "home" }),
      },
    }));

    expect(presence.at(-1)).toMatchObject({
      participants: [{ userId: "user-1", displayName: "Authenticated User" }],
    });
    expect(Object.isFrozen(presence.at(-1)!.participants)).toBe(true);
    expect(canonical.at(-1)).toMatchObject({
      tick: 11,
      sceneRevision: 3,
      entities: [{
        id: "ball-1",
        definitionId: "ball",
        x: 1.5,
        animation: "hardKick",
        animationEpoch: 7,
        behaviorState: { score: 1 },
      }],
    });
    expect(Object.isFrozen(canonical.at(-1)!.entities[0])).toBe(true);
    expect(behavior.at(-1)).toMatchObject({
      tick: 11,
      states: [{ entityId: "ball-1", state: { score: 1 } }],
    });
    expect(effects).toContainEqual(expect.objectContaining({
      entityId: "ball-1",
      effect: "goal",
      params: { team: "home" },
    }));

    const replayed: unknown[] = [];
    session.subscribeCanonicalState((snapshot) => replayed.push(snapshot));
    expect(replayed).toHaveLength(1);
    session.stop();
  });
});
