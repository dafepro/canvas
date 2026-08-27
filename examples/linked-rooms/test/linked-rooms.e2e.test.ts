import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RapierWorld,
  RoomSession,
  SimulationDriver,
  devRealtimeCredential,
  type InputIntent,
  type RenderEntity,
} from "@canvas-physics/client";
import { HostSimulation } from "@canvas-physics/client";
import {
  BehaviorRegistry,
  KickableBehavior,
  ROOM_TRAVEL_EFFECT,
  RoomTravelBehavior,
} from "@canvas-physics/core";
import {
  goAvailable,
  startCanvasd,
  waitFor,
  type Canvasd,
} from "../../../packages/client/test/support/canvasd.js";
import {
  linkedRoomDefinitions,
  adventureBallDefinition,
  pixelRoomCanvas,
  roomDoorDefinition,
  villageCanvas,
} from "../src/content.js";

const root = resolve(import.meta.dirname, "..");
const STILL: InputIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };

let server: Canvasd;
const sessions: RoomSession[] = [];

const open = (
  roomId: "linked-village" | "linked-cave" | "linked-pixel-room",
  userId: string,
  spawnPointId?: string,
  intent: () => InputIntent = () => STILL,
): RoomSession => {
  const session = new RoomSession({
    roomId,
    serverUrl: server.url,
    credentialProvider: async () => devRealtimeCredential(userId, userId),
    definitions: linkedRoomDefinitions,
    driver: SimulationDriver.local(),
    spawnPointId,
    intent,
  });
  sessions.push(session);
  return session;
};

const view = (session: RoomSession): RenderEntity[] =>
  session.entitiesToDraw(performance.now());

const hasDoor = (session: RoomSession, doorId: string): boolean =>
  view(session).some((entity) => entity.id === doorId && entity.kind === "item");

describe.skipIf(!goAvailable())("linked rooms through canvasd", () => {
  beforeAll(async () => {
    await RapierWorld.load();
  }, 120_000);

  beforeEach(async () => {
    server = await startCanvasd({
      canvasesDir: resolve(root, "server/canvases"),
      definitionsDir: resolve(root, "server/definitions"),
    });
  }, 120_000);

  afterEach(() => {
    for (const session of sessions.splice(0)) session.stop();
    server?.stop();
  });

  it("keeps a peer present and movable across a round trip and reload", async () => {
    const host = open("linked-village", "host", "village-square");
    await host.start();
    await host.whenPresented();
    await waitFor(
      "the village host and its door",
      () => host.client.hostLease.isHost && hasDoor(host, "village-cave-door"),
    );

    const originalPeer = open("linked-village", "peer", "village-square");
    await originalPeer.start();
    await originalPeer.whenPresented();
    await waitFor(
      "the original peer to see the village door",
      () => !originalPeer.client.hostLease.isHost && hasDoor(originalPeer, "village-cave-door"),
    );

    // Destination staging intentionally overlaps this participant across two
    // different rooms until the origin is ready to close.
    const cave = open("linked-cave", "peer", "from-village");
    await cave.start();
    await cave.whenPresented();
    await waitFor(
      "the staged cave and return door",
      () => cave.client.hostLease.isHost && hasDoor(cave, "cave-village-door"),
    );
    await originalPeer.stopGracefully();

    let returningIntent: InputIntent = STILL;
    const returned = open(
      "linked-village",
      "peer",
      "from-cave",
      () => returningIntent,
    );
    await returned.start();
    await returned.whenPresented();
    await waitFor(
      "the returned peer and durable village door",
      () => !returned.client.hostLease.isHost && hasDoor(returned, "village-cave-door"),
    );
    await cave.stopGracefully();

    expect(host.client.hostLease.isHost).toBe(true);
    const returnedAvatar = returned.avatarId;
    await waitFor(
      "the returned avatar to exist on the host",
      () => view(host).some((entity) => entity.id === returnedAvatar),
    );
    const startX = view(host).find((entity) => entity.id === returnedAvatar)!.x;
    returningIntent = { direction: { x: 1, y: 0 }, intensity: 1, held: true };
    await waitFor(
      "the returned peer to move after travel",
      () => (view(host).find((entity) => entity.id === returnedAvatar)?.x ?? startX) > startX + 1,
    );
    const beforeStopSequence = returned.diagnostics().inputSequence;
    returningIntent = STILL;
    await waitFor(
      "the returned peer's stop input to become canonical",
      () => {
        // Pull peer presentation so acknowledgement/reconciliation observes
        // the newest canonical packet instead of comparing a pre-stop host
        // sample with the later server-retained rejoin position.
        view(returned);
        const avatar = view(host).find((entity) => entity.id === returnedAvatar);
        const diagnostics = returned.diagnostics();
        return (
          diagnostics.inputSequence > beforeStopSequence &&
          diagnostics.acknowledgedInputSequence > beforeStopSequence &&
          (avatar?.lastProcessedInputSequence ?? 0) > beforeStopSequence &&
          Math.hypot(avatar?.vx ?? Infinity, avatar?.vy ?? Infinity) < 0.05
        );
      },
    );
    const movedX = view(host).find((entity) => entity.id === returnedAvatar)!.x;

    await returned.stopGracefully();
    const reloaded = open("linked-village", "peer");
    await reloaded.start();
    await reloaded.whenPresented();
    await waitFor(
      "the reloaded peer, avatar, and village door",
      () =>
        !reloaded.client.hostLease.isHost &&
        hasDoor(reloaded, "village-cave-door") &&
        view(host).some((entity) => entity.id === reloaded.avatarId),
    );

    expect(host.client.hostLease.isHost).toBe(true);
    expect(hasDoor(host, "village-cave-door")).toBe(true);
    expect(view(host).find((entity) => entity.id === reloaded.avatarId)!.x).toBeCloseTo(movedX, 0);
  }, 60_000);

  it("requests travel only after the avatar reaches the door midpoint", () => {
    const simulation = new HostSimulation(
      villageCanvas,
      linkedRoomDefinitions,
      new BehaviorRegistry().register(RoomTravelBehavior),
    );
    const template = villageCanvas.systemItems[0]!;
    simulation.addItem({
      ...template,
      canvasId: villageCanvas.id,
      ownerUserId: "",
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
      itemRevision: 1,
    });
    simulation.addAvatar({
      entityId: "avatar:traveler",
      clientId: "client-traveler",
      userId: "traveler",
      position: { x: 42, y: 15 },
    });

    expect(simulation.step().effects).toHaveLength(0);
    simulation.world.teleport("avatar:traveler", { x: 43.05, y: 15 });
    const effects = simulation.step().effects;

    expect(effects).toContainEqual(expect.objectContaining({
      entityId: "avatar:traveler",
      effect: ROOM_TRAVEL_EFFECT,
    }));
    expect(roomDoorDefinition.colliders[0]!.offset).toEqual({ x: 1.6, y: 0 });
    simulation.free();
  });

  it("opens the generated pixel room with its return door and kickable ball", async () => {
    const room = open("linked-pixel-room", "pixel-host", "room-start");
    await room.start();
    await room.whenPresented();
    await waitFor(
      "the pixel room, return door, and adventure ball",
      () =>
        room.client.hostLease.isHost &&
        hasDoor(room, "pixel-room-village-door") &&
        view(room).some((entity) => entity.id === "pixel-room-ball"),
    );

    expect(view(room).map(({ id }) => id)).toEqual(expect.arrayContaining([
      "pixel-room-village-door",
      "pixel-room-ball",
      room.avatarId,
    ]));
  }, 30_000);

  it("kicks the pixel-room ball faster than avatar momentum alone", () => {
    const simulation = new HostSimulation(
      pixelRoomCanvas,
      linkedRoomDefinitions,
      new BehaviorRegistry().register(RoomTravelBehavior).register(KickableBehavior),
    );
    const template = pixelRoomCanvas.systemItems.find(
      ({ definitionId }) => definitionId === adventureBallDefinition.definitionId,
    )!;
    simulation.addItem({
      ...template,
      canvasId: pixelRoomCanvas.id,
      ownerUserId: "",
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
      itemRevision: 1,
    });
    simulation.addAvatar({
      entityId: "avatar:kicker",
      clientId: "client-kicker",
      userId: "kicker",
      position: { x: 17, y: 15 },
    });
    simulation.world.setAvatarInput("avatar:kicker", { x: 1, y: 0 }, 1, 1);

    let kickedSpeed = 0;
    let kicked = false;
    for (let step = 0; step < 120; step++) {
      simulation.step();
      const state = simulation.behaviors.slot("pixel-room-ball")?.state as
        | { kickCount: number }
        | undefined;
      kicked ||= (state?.kickCount ?? 0) > 0;
      if (!kicked) continue;
      const velocity = simulation.world.registry.require("pixel-room-ball").rigidBody!.velocity;
      kickedSpeed = Math.max(kickedSpeed, Math.hypot(velocity.x, velocity.y));
    }

    expect(kicked).toBe(true);
    expect(kickedSpeed).toBeGreaterThan(pixelRoomCanvas.avatarController!.maxSpeed!);
    simulation.free();
  });
});
