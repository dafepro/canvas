import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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

/**
 * Phase 2 exit criterion (spec 23). Two clients join one room through a real
 * canvasd process and a real WebSocket. One client holds the host lease, and
 * the other sees the same avatar and item state.
 *
 * The clients run the same `RoomSession` the browser runs. Only the renderer and
 * the input controllers are absent, so this test covers the relay, the host
 * lease, the input path, and the delta path.
 */
const STILL: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

let server: Canvasd;
const sessions: RoomSession[] = [];

const session = (userId: string, intent: () => InputIntent = () => STILL): RoomSession => {
  const created = new RoomSession({
    canvasId: "rocket-canvas",
    serverUrl: server.url,
    userId,
    displayName: userId,
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

describe.skipIf(!goAvailable())("two clients through canvasd", () => {
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

  it("grants one host lease and relays the same item state to the peer", async () => {
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host and simulate", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob");
    await bob.start();
    await waitFor("bob to join", () => bob.client.clientId !== "");
    await waitFor("bob to receive host state", () => view(bob).length > 0);

    // Exactly one host, and both clients name the same one.
    expect(alice.client.isHost).toBe(true);
    expect(bob.client.isHost).toBe(false);
    expect(bob.client.hostClientId).toBe(alice.client.clientId);
    expect(bob.client.hostEpoch).toBe(alice.client.hostEpoch);

    // The peer asks the server for a durable spawn. The host simulates it.
    bob.spawnItem(crateDefinition.definitionId, { x: 40, y: 20 });
    await waitFor("the host to hold the crate", () => items(alice).length === 1);
    const crateId = items(alice)[0]!.id;
    await waitFor("the crate to reach the peer", () => entity(bob, crateId) !== undefined);

    // Compare the two views once the crate rests, so the 100 ms render delay of
    // spec 10.4 does not appear as a difference.
    await waitFor(
      "the crate to settle in both views",
      () => {
        const onHost = entity(alice, crateId);
        const onPeer = entity(bob, crateId);
        return (
          onHost !== undefined &&
          onPeer !== undefined &&
          onHost.y > 50 &&
          Math.abs(onHost.vy) < 0.2 &&
          Math.abs(onPeer.vy) < 0.2
        );
      },
      20_000,
    );

    const hostCrate = entity(alice, crateId)!;
    const peerCrate = entity(bob, crateId)!;
    expect(distance(hostCrate, peerCrate)).toBeLessThan(1);

    // The server owns the record, so the spawning user owns the item.
    expect(hostCrate.ownerUserId).toBe("bob");
  }, 90_000);

  it("moves the peer avatar on the host from relayed input", async () => {
    let bobIntent: InputIntent = STILL;
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob", () => bobIntent);
    await bob.start();
    await waitFor("bob to join", () => bob.client.clientId !== "");

    const bobAvatar = avatarEntityId(bob.client.clientId);
    await waitFor("the host to add the peer avatar", () => entity(alice, bobAvatar) !== undefined);
    const startX = entity(alice, bobAvatar)!.x;

    bobIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the host to move the peer avatar",
      () => {
        const onHost = entity(alice, bobAvatar);
        return onHost !== undefined && onHost.x - startX > 2;
      },
      20_000,
    );
    bobIntent = STILL;

    const onHost = entity(alice, bobAvatar)!;
    // Spec 10.2. The host reports the input it consumed.
    expect(onHost.lastProcessedInputSequence ?? 0).toBeGreaterThan(0);

    // The peer sees its own avatar close to the canonical position.
    await waitFor(
      "the peer view of its avatar to agree with the host",
      () => {
        const local = entity(bob, bobAvatar);
        const canonical = entity(alice, bobAvatar);
        return local !== undefined && canonical !== undefined && distance(local, canonical) < 3;
      },
      20_000,
    );
  }, 90_000);
});
