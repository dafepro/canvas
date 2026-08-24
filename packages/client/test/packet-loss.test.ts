import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  devRealtimeCredential,
  RapierWorld,
  RoomSession,
  SimulationDriver,
  avatarEntityId,
  crateDefinition,
  rocketCanvasDefinitions,
  type InputIntent,
  type RenderEntity,
} from "../src/index.js";
import { FaultInjectingWebSocketTransport } from "../src/testing/index.js";
import { goAvailable, startCanvasd, waitFor, type Canvasd } from "./support/canvasd.js";

/**
 * Phase 6, spec 20. A client that misses deltas must repair itself from the
 * next keyframe. These cases drop realtime packets on a real WebSocket and then
 * compare the peer view with the host view.
 */
const STILL: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

let server: Canvasd;
const sessions: RoomSession[] = [];

const session = (
  userId: string,
  intent: () => InputIntent = () => STILL,
  transport?: FaultInjectingWebSocketTransport,
): RoomSession => {
  const created = new RoomSession({
    transport,
    roomId: "rocket-canvas",
    serverUrl: server.url,
    credentialProvider: async () => devRealtimeCredential(userId),
    definitions: rocketCanvasDefinitions,
    driver: SimulationDriver.local(),
    intent,
  });
  sessions.push(created);
  return created;
};

const view = (room: RoomSession): RenderEntity[] => room.entitiesToDraw(performance.now());
const entity = (room: RoomSession, id: string): RenderEntity | undefined =>
  view(room).find((candidate) => candidate.id === id);
const items = (room: RoomSession): RenderEntity[] =>
  view(room).filter((candidate) => candidate.kind === "item");
const distance = (a: RenderEntity, b: RenderEntity): number =>
  Math.hypot(a.x - b.x, a.y - b.y);
const alternatingRandom = (): (() => number) => {
  let low = false;
  return () => {
    low = !low;
    return low ? 0.25 : 0.75;
  };
};

describe.skipIf(!goAvailable())("a room under network faults", () => {
  beforeAll(async () => {
    await RapierWorld.load();
    server = await startCanvasd();
  }, 120_000);

  afterEach(() => {
    for (const room of sessions.splice(0)) room.stop();
  });

  afterAll(() => {
    server?.stop();
  });

  it("repairs a peer that lost half of the realtime packets", async () => {
    const host = session("host");
    await host.start();
    await waitFor("the host lease", () => host.client.isHost && host.tick > 60);

    const lossy = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("peer"),
      faults: { inboundLoss: 0.5, inboundDelayMs: 60, random: alternatingRandom() },
    });
    const peer = session("peer", () => STILL, lossy);
    await peer.start();
    await waitFor("the peer to join", () => peer.client.clientId !== "");

    host.spawnItem(crateDefinition.definitionId, { x: 40, y: 15 });
    await waitFor("the host to hold the crate", () => items(host).length === 1, 30_000);
    const crateId = items(host)[0]!.id;

    // The crate falls and comes to rest while the peer loses half its packets.
    await waitFor(
      "the crate to rest on the host",
      () => {
        const onHost = entity(host, crateId);
        return onHost !== undefined && onHost.y > 50 && Math.abs(onHost.vy) < 0.2;
      },
      30_000,
    );
    expect(lossy.droppedIn).toBeGreaterThan(0);

    // Spec 20. The 2 Hz keyframe repairs the peer even though deltas were lost.
    await waitFor(
      "the peer view to agree with the host",
      () => {
        const onHost = entity(host, crateId);
        const onPeer = entity(peer, crateId);
        return onHost !== undefined && onPeer !== undefined && distance(onHost, onPeer) < 1;
      },
      30_000,
    );

    // The definition still reaches the peer, although a delta omits it.
    expect(entity(peer, crateId)!.definitionId).toBe(crateDefinition.definitionId);
  }, 120_000);

  it.each([50, 100, 200])(
    "repairs reordered realtime state with %d ms of latency",
    async (latencyMs) => {
      let hostIntent: InputIntent = STILL;
      const hostUserId = `latency-host-${latencyMs}`;
      const host = session(hostUserId, () => hostIntent);
      await host.start();
      await waitFor("the latency host lease", () => host.client.isHost && host.tick > 60);

      const faults = new FaultInjectingWebSocketTransport({
        credentialProvider: async () => devRealtimeCredential(`latency-peer-${latencyMs}`),
        faults: {
          inboundDelayMs: latencyMs,
          reorderEvery: 2,
          reorderDelayMs: latencyMs + 80,
        },
      });
      const peer = session(`latency-peer-${latencyMs}`, () => STILL, faults);
      await peer.start();
      await waitFor("the delayed peer to join", () => peer.client.clientId !== "", 30_000);

      const avatarId = avatarEntityId(hostUserId);
      await waitFor(
        "the delayed peer to receive the host avatar",
        () => entity(peer, avatarId) !== undefined,
        30_000,
      );
      const startX = entity(host, avatarId)!.x;
      hostIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
      await waitFor(
        "the host avatar to move",
        () => (entity(host, avatarId)?.x ?? startX) - startX > 3,
        30_000,
      );
      hostIntent = STILL;

      await waitFor(
        "the delayed and reordered peer to converge",
        () => {
          const onHost = entity(host, avatarId);
          const onPeer = entity(peer, avatarId);
          return (
            onHost !== undefined &&
            onPeer !== undefined &&
            Math.abs(onHost.vx) < 0.2 &&
            distance(onHost, onPeer) < 1
          );
        },
        30_000,
      );

      expect(faults.delayedIn).toBeGreaterThan(0);
      expect(faults.reorderedIn).toBeGreaterThan(0);
    },
    90_000,
  );

  // Spec 11.1. A reconnect gives the client a new id. A client that held the
  // lease before the break must not keep publishing state.
  it("drops the host role when a reconnect finds another host", async () => {
    const host = session("host");
    await host.start();
    await waitFor("the host lease", () => host.client.isHost && host.tick > 60);

    const peer = session("peer");
    await peer.start();
    await waitFor("the peer to join", () => peer.client.clientId !== "");
    expect(peer.client.isHost).toBe(false);

    // Pretend the peer held the lease before its connection broke.
    peer.client.isHost = true;
    expect(peer.client.hostClientId).not.toBe(peer.client.clientId);

    // The room refuses state from a client without the lease, so the guard has
    // to be on the client. Nothing may leave the peer.
    const before = peer.client.traffic.outboundBytes;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const inputOnly = peer.client.traffic.outboundBytes - before;
    // Input and heartbeats still flow. A delta at 15 Hz would be far larger.
    expect(inputOnly).toBeLessThan(2000);
  }, 60_000);

  it("keeps moving the peer avatar when input packets are lost", async () => {
    let peerIntent: InputIntent = STILL;
    const host = session("host");
    await host.start();
    await waitFor("the host lease", () => host.client.isHost && host.tick > 60);

    const lossy = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("peer"),
      faults: { outboundLoss: 0.5, random: alternatingRandom() },
    });
    const peer = session("peer", () => peerIntent, lossy);
    await peer.start();
    await waitFor("the peer to join", () => peer.client.clientId !== "");

    const peerAvatar = avatarEntityId(peer.client.userId);
    await waitFor(
      "the host to add the peer avatar",
      () => entity(host, peerAvatar) !== undefined,
      30_000,
    );
    const startX = entity(host, peerAvatar)!.x;

    peerIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the host to move the peer avatar",
      () => {
        const onHost = entity(host, peerAvatar);
        return onHost !== undefined && onHost.x - startX > 3;
      },
      30_000,
    );
    peerIntent = STILL;
    expect(lossy.droppedOut).toBeGreaterThan(0);
  }, 120_000);
});
