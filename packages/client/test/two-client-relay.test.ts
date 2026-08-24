import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultRocketConfig } from "@canvas-physics/core";
import {
  devRealtimeCredential,
  RapierWorld,
  RoomSession,
  SimulationDriver,
  avatarEntityId,
  crateDefinition,
  rocketDefinition,
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

describe.skipIf(!goAvailable())("two clients through canvasd", () => {
  beforeAll(async () => {
    await RapierWorld.load();
  }, 120_000);

  beforeEach(async () => {
    server = await startCanvasd();
  }, 120_000);

  afterEach(() => {
    for (const room of sessions.splice(0)) room.stop();
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
    expect(peerCrate.ownerUserId).toBe("bob");

    const beforePreviewRevision = bob.client.sceneRevision;
    const previewTransform = {
      x: hostCrate.x + 4,
      y: hostCrate.y,
      rotation: hostCrate.rotation,
    };
    bob.moveItem(crateId, previewTransform, true);
    await waitFor(
      "the host to apply the owner's preview move",
      () => Math.abs((entity(alice, crateId)?.x ?? 0) - previewTransform.x) < 0.5,
    );
    expect(bob.client.sceneRevision).toBe(beforePreviewRevision);

    bob.moveItem(crateId, previewTransform);
    await waitFor(
      "the final move to advance the scene revision",
      () => bob.client.sceneRevision > beforePreviewRevision,
    );

    bob.rotateItem(crateId, Math.PI / 4);
    await waitFor(
      "the host to apply the owner's durable rotation",
      () => Math.abs((entity(alice, crateId)?.rotation ?? 0) - Math.PI / 4) < 0.1,
    );

    bob.setItemIsolation(crateId, true);
    await waitFor(
      "live-edit isolation to reach the host and peer",
      () => entity(alice, crateId)?.isolated === true && entity(bob, crateId)?.isolated === true,
    );

    const revisionBeforeUnauthorizedEdit = alice.client.sceneRevision;
    alice.setItemIsolation(crateId, false);
    await waitFor(
      "the server to reject another player's isolation edit",
      () => alice.diagnostics().lastRejection !== undefined,
    );
    expect(alice.client.sceneRevision).toBe(revisionBeforeUnauthorizedEdit);
    expect(entity(alice, crateId)?.isolated).toBe(true);

    bob.setItemIsolation(crateId, false);
    await waitFor(
      "the owner to return the item to live simulation",
      () => entity(alice, crateId)?.isolated === false && entity(bob, crateId)?.isolated === false,
    );

    bob.setItemCollisionsEnabled(crateId, false);
    await waitFor(
      "the collision override to reach the host and peer",
      () =>
        entity(alice, crateId)?.collisionsDisabled === true &&
        entity(bob, crateId)?.collisionsDisabled === true,
    );

    bob.setItemCollisionsEnabled(crateId, true);
    await waitFor(
      "the owner to restore collisions",
      () =>
        entity(alice, crateId)?.collisionsDisabled === false &&
        entity(bob, crateId)?.collisionsDisabled === false,
    );
  }, 90_000);

  it("applies an owner's durable config change to the live behavior", async () => {
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob");
    await bob.start();
    await waitFor("bob to receive host state", () => view(bob).length > 0);

    bob.spawnItem(rocketDefinition.definitionId, { x: 70, y: 62 });
    await waitFor("the host to add the rocket", () => items(alice).length === 1);
    const rocketId = items(alice)[0]!.id;
    bob.setItemConfig(rocketId, {
      ...defaultRocketConfig,
      countdownSeconds: 0.25,
      graceSeconds: 1,
    });
    bob.moveItem(rocketId, { x: 50, y: 62, rotation: 0 });

    await waitFor(
      "both durable edits to settle",
      () => bob.client.sceneRevision >= 3 || bob.diagnostics().lastRejection !== undefined,
    );
    expect(bob.diagnostics().lastRejection).toBeUndefined();

    await waitFor(
      "the moved rocket to arm",
      () =>
        (entity(alice, rocketId)?.behaviorState as { phase?: string } | undefined)
          ?.phase === "arming",
      2_000,
    );
    expect(
      (entity(alice, rocketId)?.behaviorState as { countdownTicks?: number } | undefined)
        ?.countdownTicks,
    ).toBe(15);
    await waitFor(
      "the updated short countdown to launch the rocket",
      () => {
        const state = entity(alice, rocketId)?.behaviorState as
          | { phase?: string; launchCount?: number }
          | undefined;
        return state?.phase === "flying" && state.launchCount === 1;
      },
      1_500,
    );
    await waitFor(
      "the launch animation to reach the peer",
      () => {
        const onPeer = entity(bob, rocketId);
        return onPeer?.animation === "launch" && (onPeer.animationEpoch ?? 0) > 0;
      },
      2_000,
    );
  }, 90_000);

  it("moves the peer avatar on the host from relayed input", async () => {
    let bobIntent: InputIntent = STILL;
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob", () => bobIntent);
    await bob.start();
    await waitFor("bob to join", () => bob.client.clientId !== "");

    const bobAvatar = avatarEntityId(bob.client.userId);
    await waitFor("the host to add the peer avatar", () => entity(alice, bobAvatar) !== undefined);
    const startX = entity(alice, bobAvatar)!.x;

    bobIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the host to move the peer avatar",
      () => {
        const onHost = entity(alice, bobAvatar);
        return onHost !== undefined && onHost.x - startX > 8;
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

    const beforeMigration = entity(alice, bobAvatar)!;
    alice.stop();
    await waitFor("bob to become host", () => bob.client.isHost);
    expect(bob.diagnostics()).toMatchObject({
      hostMigrations: 1,
      lastMigrationReason: "host_disconnected",
    });
    await waitFor(
      "bob's avatar to keep its canonical position through migration",
      () => {
        const migrated = entity(bob, bobAvatar);
        return migrated !== undefined && distance(migrated, beforeMigration) < 2;
      },
      20_000,
    );
  }, 90_000);

  it("keeps peer-local avatar presentation smooth across checkpoint boundaries", async () => {
    let bobIntent: InputIntent = STILL;
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob", () => bobIntent);
    await bob.start();
    await waitFor("bob to join", () => bob.client.clientId !== "");
    const bobAvatar = avatarEntityId(bob.client.userId);
    await waitFor("host to add bob's avatar", () => entity(alice, bobAvatar) !== undefined);
    await waitFor("bob to receive its canonical avatar", () => entity(bob, bobAvatar) !== undefined);

    bobIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    const samples: Array<{ at: number; x: number }> = [];
    const deadline = performance.now() + 2_400;
    while (performance.now() < deadline) {
      const at = performance.now();
      const avatar = entity(bob, bobAvatar);
      if (avatar) samples.push({ at, x: avatar.x });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    bobIntent = STILL;

    const steps = samples.slice(1).map((sample, index) => {
      const previous = samples[index]!;
      return sample.x - previous.x;
    });
    const slowest = steps.indexOf(Math.min(...steps));
    const fastest = steps.indexOf(Math.max(...steps));
    const motionDiagnostics = JSON.stringify({
      slowest: { step: steps[slowest], before: samples[slowest], after: samples[slowest + 1] },
      fastest: { step: steps[fastest], before: samples[fastest], after: samples[fastest + 1] },
    });
    expect(samples.at(-1)!.x - samples[0]!.x).toBeGreaterThan(8);
    expect(Math.min(...steps), motionDiagnostics).toBeGreaterThan(-0.08);
    // A loaded worker may deliver up to four 60 Hz steps together. The peer
    // must still avoid a network correction large enough to exceed that bound.
    expect(Math.max(...steps), motionDiagnostics).toBeLessThan(1.2);
  }, 90_000);

  it("resumes a timer-driven workflow on the replacement host", async () => {
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob");
    await bob.start();
    await waitFor("bob to receive host state", () => view(bob).length > 0);

    // The local avatar spawns around x=50, so the rocket's arm sensor sees it.
    alice.spawnItem(rocketDefinition.definitionId, { x: 50, y: 62 });
    await waitFor(
      "the rocket countdown to arm",
      () =>
        items(alice).some(
          (item) =>
            item.definitionId === rocketDefinition.definitionId &&
            (item.behaviorState as { phase?: string } | undefined)?.phase === "arming",
        ),
      10_000,
    );
    // Cross a periodic checkpoint boundary, but disconnect before the
    // three-second countdown can complete on the old host.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(
      items(alice).find((item) => item.definitionId === rocketDefinition.definitionId)
        ?.behaviorState,
    ).toMatchObject({ phase: "arming", launchCount: 0 });

    alice.stop();
    await waitFor("bob to become host", () => bob.client.isHost);
    await waitFor(
      "the replacement host to finish the restored countdown",
      () => {
        const rocket = items(bob).find(
          (item) => item.definitionId === rocketDefinition.definitionId,
        );
        const state = rocket?.behaviorState as
          | { phase?: string; launchCount?: number }
          | undefined;
        return state?.phase === "flying" && state.launchCount === 1;
      },
      6_000,
    );
  }, 90_000);

  // Addendum A1. The disabled flag rides on the input, so the host holds the
  // newest value even after a lost packet.
  it("disables the peer avatar on the host and enables it again", async () => {
    let bobIntent: InputIntent = STILL;
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob", () => bobIntent);
    await bob.start();
    await waitFor("bob to join", () => bob.client.clientId !== "");

    const bobAvatar = avatarEntityId(bob.client.userId);
    await waitFor("the host to add the peer avatar", () => entity(alice, bobAvatar) !== undefined);

    bobIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true, disabled: true };
    await waitFor(
      "the host to disable the peer avatar",
      () => entity(alice, bobAvatar)?.disabled === true,
      20_000,
    );

    // A disabled avatar does not move, even though the intent asks it to.
    const held = entity(alice, bobAvatar)!.x;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(Math.abs(entity(alice, bobAvatar)!.x - held)).toBeLessThan(0.001);

    bobIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the host to move the avatar again",
      () => {
        const onHost = entity(alice, bobAvatar);
        return onHost !== undefined && onHost.disabled !== true && onHost.x - held > 2;
      },
      20_000,
    );
    bobIntent = STILL;
  }, 90_000);

  it("keeps avatars and checkpointed item placement when the host reconnects", async () => {
    const alice = session("alice");
    await alice.start();
    await waitFor("alice to host", () => alice.client.isHost && alice.tick > 60);

    const bob = session("bob");
    await bob.start();
    await waitFor("bob to receive host state", () => view(bob).length > 0);

    alice.spawnItem(crateDefinition.definitionId, { x: 40, y: 20 });
    await waitFor(
      "the crate to settle before the checkpoint",
      () =>
        items(alice).length === 1 &&
        items(alice)[0]!.y > 55 &&
        Math.abs(items(alice)[0]!.vy) < 0.2,
      20_000,
    );
    const crateId = items(alice)[0]!.id;
    const settledY = items(alice)[0]!.y;
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const oldAliceAvatar = alice.avatarId;
    alice.stop();
    await waitFor("bob to take the host lease", () => bob.client.isHost);
    await waitFor(
      "the departed participant avatar to remain disabled",
      () => entity(bob, oldAliceAvatar)?.disabled === true,
    );

    const rejoinedAlice = session("alice");
    await rejoinedAlice.start();
    await waitFor(
      "the rejoined participant to reactivate its stable avatar and receive the crate",
      () => {
        const rejoinedView = view(rejoinedAlice);
        const crate = rejoinedView.find((candidate) => candidate.id === crateId);
        const aliceAvatar = rejoinedView.find(
          (candidate) => candidate.id === oldAliceAvatar,
        );
        return (
          rejoinedView.some((candidate) => candidate.id === bob.avatarId) &&
          aliceAvatar?.disabled !== true &&
          crate?.definitionId === crateDefinition.definitionId &&
          Math.abs(crate.y - settledY) < 1
        );
      },
      20_000,
    );
    expect(rejoinedAlice.avatarId).toBe(oldAliceAvatar);
  }, 90_000);
});
