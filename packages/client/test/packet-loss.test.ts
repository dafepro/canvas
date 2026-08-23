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
import { goAvailable, startCanvasd, waitFor, type Canvasd } from "./support/canvasd.js";
import { LossyTransport } from "./support/lossy-transport.js";

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
  transport?: LossyTransport,
): RoomSession => {
  const created = new RoomSession({
    transport,
    canvasId: "rocket-canvas",
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

describe.skipIf(!goAvailable())("a room under packet loss", () => {
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

    const lossy = new LossyTransport(
      async () => devRealtimeCredential("peer"),
      { inboundLoss: 0.5, inboundDelayMs: 60 },
    );
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

    const lossy = new LossyTransport(
      async () => devRealtimeCredential("peer"),
      { outboundLoss: 0.5 },
    );
    const peer = session("peer", () => peerIntent, lossy);
    await peer.start();
    await waitFor("the peer to join", () => peer.client.clientId !== "");

    const peerAvatar = avatarEntityId(peer.client.clientId);
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
