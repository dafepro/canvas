import { describe, expect, it } from "vitest";
import type { EffectEmission } from "@canvas-physics/core";
import {
  toJsonBytes,
  type EntityState,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import { emptySnapshot } from "@canvas-physics/core";
import {
  RoomSession,
  SimulationDriver,
  rocketCanvas,
  rocketCanvasDefinitions,
} from "../src/index.js";
import type { JoinDescriptor, RoomTransport, TransportStatus } from "../src/index.js";

/**
 * Spec 20. A client that joins during a workflow reads the remaining countdown
 * from the behavior state in the host packet. The effect that started the
 * countdown reached only the clients that were present.
 */
class FakeTransport implements RoomTransport {
  readonly sent: RoomEnvelope[] = [];
  status: TransportStatus = "idle";
  private handlers = new Set<(message: RoomEnvelope) => void>();

  connect(_join: JoinDescriptor): Promise<void> {
    this.status = "open";
    return Promise.resolve();
  }
  sendReliable(message: RoomEnvelope): void {
    this.sent.push(message);
  }
  sendRealtime(message: RoomEnvelope): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: RoomEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onStatus(): () => void {
    return () => {};
  }
  close(): void {
    this.status = "closed";
  }
  /** Delivers a packet as if the server had sent it. */
  deliver(message: RoomEnvelope): void {
    for (const handler of this.handlers) handler(message);
  }
}

const idleDriver = (): SimulationDriver =>
  new SimulationDriver(() => ({ send: () => {}, terminate: () => {} }));

const blank = (): RoomEnvelope => ({
  roomId: rocketCanvas.id,
  hostEpoch: 7,
  sequence: 0,
  tick: 0,
  senderClientId: "host-1",
});

const entityState = (behaviorState: unknown): EntityState => ({
  entityId: "rocket-1",
  quantizedTransform: {
    x: 7000,
    y: 6000,
    rotation: 0,
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    z: 0,
    vz: 0,
  },
  lastProcessedInputSequence: 0,
  spriteVariant: "armed",
  behaviorStateJson: toJsonBytes(behaviorState),
  quarantined: false,
  definitionId: "rocket",
});

const joinedSession = async (): Promise<{
  session: RoomSession;
  transport: FakeTransport;
  effects: EffectEmission[];
}> => {
  const transport = new FakeTransport();
  const effects: EffectEmission[] = [];
  const session = new RoomSession({
    canvasId: rocketCanvas.id,
    serverUrl: "http://127.0.0.1:1",
    userId: "carol",
    displayName: "carol",
    definitions: rocketCanvasDefinitions,
    transport,
    driver: idleDriver(),
    onEffect: (emission) => effects.push(emission),
  });
  await session.start();
  transport.deliver({
    ...blank(),
    joinAccepted: {
      clientId: "carol-1",
      sceneRevision: 4,
      hostEpoch: 7,
      hostClientId: "host-1",
      canvasDefinitionJson: toJsonBytes(rocketCanvas),
      snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
      roomWasSleeping: false,
      tickRate: 60,
    },
  });
  return { session, transport, effects };
};

describe("a client that joins during a countdown", () => {
  it("starts the overlay from the behavior state in a keyframe", async () => {
    const { session, transport, effects } = await joinedSession();

    // The host armed the rocket at tick 100 with a 3 second countdown. The
    // keyframe arrives at tick 160, so 2 seconds remain at 60 Hz.
    session.client.hostEpoch = 7;
    const state = { phase: "arming", armedAtTick: 100, countdownTicks: 180 };
    // The session must not be the host for the peer path to run.
    expect(session.client.isHost).toBe(false);

    deliverFullState(transport, state, 160);

    const started = effects.filter((effect) => effect.effect === "countdown");
    expect(started).toHaveLength(1);
    expect(started[0]!.mode).toBe("start");
    expect(Number(started[0]!.params?.seconds)).toBeCloseTo(2, 5);

    // A second keyframe must not start a second overlay.
    deliverFullState(transport, state, 170);
    expect(effects.filter((effect) => effect.effect === "countdown")).toHaveLength(1);

    // The rocket launches, so the overlay stops.
    deliverFullState(transport, { ...state, phase: "flying" }, 280);
    const countdowns = effects.filter((effect) => effect.effect === "countdown");
    expect(countdowns).toHaveLength(2);
    expect(countdowns[1]!.mode).toBe("stop");

    session.stop();
  });

  it("ignores a countdown that already expired", async () => {
    const { session, transport, effects } = await joinedSession();
    deliverFullState(transport, { phase: "arming", armedAtTick: 100, countdownTicks: 180 }, 400);
    expect(effects.filter((effect) => effect.effect === "countdown")).toHaveLength(0);
    session.stop();
  });
});

/** Sends one keyframe through the fake transport. */
const deliverFullState = (
  transport: FakeTransport,
  state: unknown,
  tick: number,
): void => {
  transport.deliver({
    ...blank(),
    tick,
    fullState: {
      entities: [entityState(state)],
      avatars: [],
      sceneRevision: 4,
      tickRate: 60,
    },
  });
};
