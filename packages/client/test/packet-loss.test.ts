import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
    await waitFor("the host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const lossy = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("peer"),
      faults: { inboundLoss: 0.5, inboundDelayMs: 60, random: alternatingRandom() },
    });
    const peer = session("peer", () => STILL, lossy);
    await peer.start();
    await waitFor("the peer to join", () => peer.client.connectionIdentity.clientId !== "");

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
      await waitFor("the latency host lease", () => host.client.hostLease.isHost && host.tick > 60);

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
      await waitFor("the delayed peer to join", () => peer.client.connectionIdentity.clientId !== "", 30_000);

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

  it("keeps a peer's direct drag smooth through LAN-like delay and reordering", async () => {
    let peerIntent: InputIntent = STILL;
    const host = session("direct-jitter-host");
    await host.start();
    await waitFor("the direct jitter host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const faults = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("direct-jitter-peer"),
      faults: {
        inboundDelayMs: 45,
        inboundJitterMs: 30,
        // Fifteen realtime deltas is approximately one second at the default
        // relay rate, matching the reported periodic LAN disturbance.
        reorderEvery: 15,
        reorderDelayMs: 180,
      },
    });
    const peer = session("direct-jitter-peer", () => peerIntent, faults);
    await peer.start();
    await waitFor("the direct jitter peer join", () => peer.client.connectionIdentity.clientId !== "", 30_000);

    const avatarId = avatarEntityId("direct-jitter-peer");
    await waitFor(
      "the direct jitter avatar",
      () => entity(host, avatarId) !== undefined && entity(peer, avatarId) !== undefined,
      30_000,
    );
    const start = entity(peer, avatarId)!;
    let targetX = start.x;
    const samples: number[] = [];
    const deadline = performance.now() + 2_400;
    while (performance.now() < deadline) {
      targetX = Math.min(start.x + 16, targetX + 0.12);
      peerIntent = {
        direction: { x: 1, y: 0 },
        intensity: 1,
        held: true,
        target: { x: targetX, y: start.y },
      };
      const avatar = entity(peer, avatarId);
      if (avatar) samples.push(avatar.x);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    peerIntent = STILL;

    const steps = samples.slice(1).map((x, index) => x - samples[index]!);
    const diagnostics = JSON.stringify({
      backwards: Math.min(...steps),
      catchUp: Math.max(...steps),
      delayed: faults.delayedIn,
      reordered: faults.reorderedIn,
      reconcile: peer.diagnostics().reconcileError,
    });
    expect(samples.at(-1)! - samples[0]!, diagnostics).toBeGreaterThan(10);
    expect(Math.min(...steps), diagnostics).toBeGreaterThan(-0.08);
    expect(Math.max(...steps), diagnostics).toBeLessThan(0.8);
    expect(faults.reorderedIn).toBeGreaterThan(0);
  }, 90_000);

  it("keeps acknowledged peer prediction moving tangentially along an edge", async () => {
    let peerIntent: InputIntent = STILL;
    const host = session("edge-ack-host");
    await host.start();
    await waitFor("the edge acknowledgement host", () => host.client.hostLease.isHost && host.tick > 60);

    const faults = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("edge-ack-peer"),
      faults: {
        inboundDelayMs: 70,
        inboundJitterMs: 35,
        reorderEvery: 12,
        reorderDelayMs: 190,
      },
    });
    const peer = session("edge-ack-peer", () => peerIntent, faults);
    await peer.start();
    await waitFor("the edge acknowledgement peer", () => peer.client.connectionIdentity.clientId !== "", 30_000);
    const avatarId = avatarEntityId("edge-ack-peer");
    await waitFor(
      "the edge acknowledgement avatar",
      () => entity(host, avatarId) !== undefined && entity(peer, avatarId) !== undefined,
      30_000,
    );

    let targetY = 20;
    peerIntent = {
      direction: { x: 1, y: -1 },
      intensity: 1,
      held: true,
      target: { x: 200, y: targetY },
    };
    await waitFor(
      "the peer prediction to reach the right edge",
      () => {
        const avatar = entity(peer, avatarId);
        return avatar !== undefined && avatar.x > 97.8 && Math.abs(avatar.y - 20) < 0.2;
      },
      30_000,
    );

    const samples: Array<{ x: number; y: number }> = [];
    const deadline = performance.now() + 2_400;
    while (performance.now() < deadline) {
      targetY += 0.14;
      peerIntent = {
        direction: { x: 0, y: 1 },
        intensity: 1,
        held: true,
        target: { x: 200, y: targetY },
      };
      const avatar = entity(peer, avatarId);
      if (avatar) samples.push({ x: avatar.x, y: avatar.y });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    peerIntent = STILL;

    const tangentSteps = samples.slice(1).map((sample, index) =>
      sample.y - samples[index]!.y);
    const diagnostics = JSON.stringify({
      minTangentStep: Math.min(...tangentSteps),
      maxNormalError: Math.max(...samples.map(({ x }) => Math.abs(98.8 - x))),
      session: peer.diagnostics(),
    });
    expect(samples.at(-1)!.y - samples[0]!.y, diagnostics).toBeGreaterThan(12);
    expect(Math.min(...tangentSteps), diagnostics).toBeGreaterThan(-0.1);
    expect(Math.max(...samples.map(({ x }) => Math.abs(98.8 - x))), diagnostics)
      .toBeLessThan(0.4);
    expect(peer.diagnostics().acknowledgedInputSequence).toBeGreaterThan(0);
  }, 90_000);

  it("rejoins and converges while inbound state remains delayed and reordered", async () => {
    let hostIntent: InputIntent = STILL;
    let credentialCalls = 0;
    const hostUserId = "fault-reconnect-host";
    const host = session(hostUserId, () => hostIntent);
    await host.start();
    await waitFor("the reconnect test host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const faults = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => {
        credentialCalls++;
        return devRealtimeCredential("fault-reconnect-peer");
      },
      backoffMs: [20],
      faults: {
        inboundDelayMs: 100,
        reorderEvery: 2,
        reorderDelayMs: 180,
      },
    });
    const peer = session("fault-reconnect-peer", () => STILL, faults);
    await peer.start();
    await waitFor("the faulted peer to join", () => peer.client.connectionIdentity.clientId !== "", 30_000);

    const avatarId = avatarEntityId(hostUserId);
    hostIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the faulted peer to observe moving state",
      () => entity(peer, avatarId) !== undefined && faults.reorderedIn > 0,
      30_000,
    );
    const oldClientId = peer.client.connectionIdentity.clientId;
    const beforeInterruptX = entity(host, avatarId)!.x;

    expect(faults.interrupt()).toBe(true);
    await waitFor(
      "the faulted peer to receive a fresh connection identity",
      () => peer.client.connectionIdentity.clientId !== oldClientId && faults.status === "open",
      30_000,
    );
    expect(credentialCalls).toBeGreaterThanOrEqual(2);

    await waitFor(
      "the host avatar to keep moving through the peer reconnect",
      () => (entity(host, avatarId)?.x ?? beforeInterruptX) > beforeInterruptX + 0.2,
      30_000,
    );
    hostIntent = STILL;
    await waitFor(
      "the reconnected peer to converge under the same faults",
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
  }, 120_000);

  it("migrates moving state and a running workflow to a faulted replacement host", async () => {
    let replacementIntent: InputIntent = STILL;
    const host = session("fault-migration-host");
    await host.start();
    await waitFor("the migration test host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const faults = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("fault-migration-peer"),
      faults: {
        inboundDelayMs: 100,
        reorderEvery: 2,
        reorderDelayMs: 180,
      },
    });
    const replacement = session(
      "fault-migration-peer",
      () => replacementIntent,
      faults,
    );
    await replacement.start();
    await waitFor(
      "the faulted replacement peer to join",
      () => replacement.client.connectionIdentity.clientId !== "",
      30_000,
    );

    const replacementAvatarId = avatarEntityId("fault-migration-peer");
    await waitFor(
      "the original host to add the replacement avatar",
      () => entity(host, replacementAvatarId) !== undefined,
      30_000,
    );
    const peerStartX = entity(host, replacementAvatarId)!.x;
    replacementIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the replacement avatar to move while it is still a peer",
      () =>
        (entity(host, replacementAvatarId)?.x ?? peerStartX) > peerStartX + 2 &&
        faults.reorderedIn > 0,
      30_000,
    );

    host.spawnItem(rocketDefinition.definitionId, { x: 50, y: 62 });
    await waitFor(
      "the rocket workflow to reach the faulted peer",
      () =>
        items(replacement).some(
          (item) =>
            item.definitionId === rocketDefinition.definitionId &&
            (item.behaviorState as { phase?: string } | undefined)?.phase === "arming",
        ),
      30_000,
    );
    const rocketId = items(replacement).find(
      (item) => item.definitionId === rocketDefinition.definitionId,
    )!.id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(
      (entity(replacement, rocketId)?.behaviorState as
        | { phase?: string; launchCount?: number }
        | undefined),
    ).toMatchObject({ phase: "arming", launchCount: 0 });

    const beforeMigrationX = entity(host, replacementAvatarId)!.x;
    host.stop();
    await waitFor(
      "the faulted peer to become replacement host",
      () => replacement.client.hostLease.isHost,
      30_000,
    );
    await waitFor(
      "the moving avatar to continue on the replacement host",
      () => (entity(replacement, replacementAvatarId)?.x ?? beforeMigrationX) > beforeMigrationX + 2,
      30_000,
    );
    replacementIntent = STILL;
    await waitFor(
      "the replacement host to finish the restored workflow",
      () => {
        const state = entity(replacement, rocketId)?.behaviorState as
          | { phase?: string; launchCount?: number }
          | undefined;
        return state?.phase === "flying" && state.launchCount === 1;
      },
      10_000,
    );

    expect(faults.delayedIn).toBeGreaterThan(0);
    expect(faults.reorderedIn).toBeGreaterThan(0);
  }, 120_000);

  it("reconnects in the background without reclaiming the host lease", async () => {
    let returningIntent: InputIntent = STILL;
    const faults = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("background-host"),
      backoffMs: [20],
      faults: {
        inboundDelayMs: 100,
        reorderEvery: 2,
        reorderDelayMs: 180,
      },
    });
    const backgrounded = session("background-host", () => returningIntent, faults);
    let backgroundHostEligible: boolean | undefined;
    backgrounded.subscribePresence(({ participants }) => {
      backgroundHostEligible = participants.find(
        ({ participantId }) => participantId === "background-host",
      )?.hostEligible;
    });
    await backgrounded.start();
    await waitFor(
      "the background test host lease",
      () => backgrounded.client.hostLease.isHost && backgrounded.tick > 60,
    );

    const foreground = session("background-peer");
    await foreground.start();
    await waitFor("the foreground peer to join", () => foreground.client.connectionIdentity.clientId !== "");

    const oldClientId = backgrounded.client.connectionIdentity.clientId;
    backgrounded.setPageVisible(false);
    expect(backgrounded.lifecycleState).toBe("backgrounded");
    expect(faults.interrupt()).toBe(true);

    await waitFor(
      "the foreground peer to replace the hidden host",
      () => foreground.client.hostLease.isHost,
      30_000,
    );
    await waitFor(
      "the hidden client to reconnect without a host lease",
      () =>
        backgrounded.client.connectionIdentity.clientId !== oldClientId &&
        faults.status === "open" &&
        backgrounded.lifecycleState === "backgrounded" &&
        backgroundHostEligible === false &&
        !backgrounded.client.hostLease.isHost,
      30_000,
    );

    backgrounded.setPageVisible(true);
    expect(backgrounded.lifecycleState).toBe("active");
    const returningAvatarId = avatarEntityId("background-host");
    await waitFor(
      "the replacement host to restore the returning avatar",
      () => entity(foreground, returningAvatarId) !== undefined,
      30_000,
    );
    const startX = entity(foreground, returningAvatarId)!.x;
    returningIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the resumed peer to move under delayed and reordered state",
      () =>
        (entity(foreground, returningAvatarId)?.x ?? startX) > startX + 2 &&
        faults.reorderedIn > 0,
      30_000,
    );
    returningIntent = STILL;
  }, 120_000);

  // Spec 11.1. A reconnect gives the client a new id. A client that held the
  // lease before the break must not keep publishing state.
  it("does not publish host state without a matching immutable lease", async () => {
    const host = session("host");
    await host.start();
    await waitFor("the host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const peer = session("peer");
    await peer.start();
    await waitFor("the peer to join", () => peer.client.connectionIdentity.clientId !== "");
    expect(peer.client.hostLease.isHost).toBe(false);

    expect(Object.isFrozen(peer.client.hostLease)).toBe(true);
    expect(peer.client.hostLease.hostClientId).not.toBe(peer.client.connectionIdentity.clientId);

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
    await waitFor("the host lease", () => host.client.hostLease.isHost && host.tick > 60);

    const lossy = new FaultInjectingWebSocketTransport({
      credentialProvider: async () => devRealtimeCredential("peer"),
      faults: { outboundLoss: 0.5, random: alternatingRandom() },
    });
    const peer = session("peer", () => peerIntent, lossy);
    await peer.start();
    await waitFor("the peer to join", () => peer.client.connectionIdentity.clientId !== "");

    const peerAvatar = avatarEntityId(peer.client.connectionIdentity.userId);
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
