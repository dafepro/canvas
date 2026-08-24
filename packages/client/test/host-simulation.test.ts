import { beforeAll, describe, expect, it } from "vitest";
import {
  BehaviorRegistry,
  defaultRocketConfig,
  KickableBehavior,
  MigrationChain,
  PortalBehavior,
  RocketBehavior,
  resolveItemConfig,
  type ItemDefinition,
  type ItemBehavior,
  type ItemInstance,
} from "@canvas-physics/core";
import {
  HostSimulation,
  RapierWorld,
  ballDefinition,
  crateDefinition,
  rocketCanvas,
  rocketCanvasDefinitions,
  rocketDefinition,
} from "../src/index.js";

beforeAll(async () => {
  await RapierWorld.load();
}, 30_000);

const registry = () =>
  new BehaviorRegistry()
    .register(RocketBehavior)
    .register(KickableBehavior)
    .register(PortalBehavior);

const instance = (
  entityId: string,
  definition: ItemDefinition,
  x: number,
  y: number,
): ItemInstance => ({
  entityId,
  canvasId: rocketCanvas.id,
  definitionId: definition.definitionId,
  definitionVersion: definition.version,
  ownerUserId: "alice",
  transform: { x, y, rotation: 0 },
  resolvedConfig: resolveItemConfig(
    definition as ItemDefinition<Record<string, unknown>>,
    {
      width: rocketCanvas.size.width,
      height: rocketCanvas.size.height,
      orientation: rocketCanvas.orientation,
    },
  ),
  createdAt: new Date().toISOString(),
  sceneRevision: 1,
});

const build = () =>
  new HostSimulation(rocketCanvas, rocketCanvasDefinitions, registry(), 60);

describe("HostSimulation with real physics", () => {
  it("isolates an item from physics and behavior until it is made live again", () => {
    const counterBehavior: ItemBehavior<Record<string, never>, { ticks: number }> = {
      behaviorType: "test.liveCounter",
      stateVersion: 1,
      subscribes: ["tick"],
      initialState: () => ({ ticks: 0 }),
      onEvent: (_context, _config, state) => ({
        state: { ticks: state.ticks + 1 },
        commands: [],
      }),
    };
    const liveDefinition: ItemDefinition = {
      ...ballDefinition,
      definitionId: "test-live-ball",
      behaviorType: counterBehavior.behaviorType,
      defaultConfig: {},
    };
    const simulation = new HostSimulation(
      rocketCanvas,
      [liveDefinition],
      new BehaviorRegistry().register(counterBehavior),
      60,
    );
    simulation.addItem(instance("live-1", liveDefinition, 50, 20));
    simulation.addItem(instance("striker", liveDefinition, 44, 20));
    simulation.world.setVelocity("live-1", { x: 6, y: 0 }, 0);
    simulation.world.setVelocity("striker", { x: 6, y: 0 }, 0);
    const activeColliders = simulation.world.activeColliderCount;
    simulation.setItemIsolation("live-1", true);
    const held = { ...simulation.world.registry.require("live-1").transform };

    for (let index = 0; index < 60; index++) simulation.step();

    expect(simulation.world.registry.require("live-1").transform).toMatchObject(held);
    expect(simulation.world.activeColliderCount).toBe(activeColliders);
    expect(simulation.world.registry.require("striker").transform.x).toBeLessThan(50);
    expect(simulation.behaviors.slot("live-1")?.state).toEqual({ ticks: 0 });
    expect(
      simulation.snapshot().items.find(({ entityId }) => entityId === "live-1")?.isolated,
    ).toBe(true);

    simulation.world.teleport("live-1", { x: 52, y: 20 }, Math.PI / 4);
    expect(simulation.world.registry.require("live-1").transform).toMatchObject({
      x: 52,
      y: 20,
      rotation: Math.PI / 4,
    });
    expect(simulation.snapshot().items.find(({ entityId }) => entityId === "live-1")?.isolated)
      .toBe(true);

    simulation.setItemIsolation("live-1", false);
    for (let index = 0; index < 10; index++) simulation.step();
    expect(simulation.world.registry.require("live-1").transform.x).toBeGreaterThan(held.x);
    expect(simulation.behaviors.slot("live-1")?.state).toEqual({ ticks: 10 });
    simulation.free();
  });

  it("disables item collisions without stopping its motion", () => {
    const simulation = build();
    simulation.addItem(instance("ghost-ball", ballDefinition, 50, 20));
    simulation.world.setVelocity("ghost-ball", { x: 6, y: 0 }, 0);
    const collidersBefore = simulation.world.activeColliderCount;
    const startX = simulation.world.registry.require("ghost-ball").transform.x;

    expect(simulation.setItemCollisionsEnabled("ghost-ball", false)).toBe(true);
    expect(simulation.world.activeColliderCount).toBeLessThan(collidersBefore);
    for (let index = 0; index < 10; index++) simulation.step();

    expect(simulation.world.registry.require("ghost-ball").transform.x).toBeGreaterThan(startX);
    expect(simulation.snapshot().items[0]?.collisionsDisabled).toBe(true);
    expect(simulation.setItemCollisionsEnabled("ghost-ball", true)).toBe(true);
    expect(simulation.world.activeColliderCount).toBe(collidersBefore);
    simulation.free();
  });

  it("persists a behavior-authored custom sprite tint", () => {
    const tintBehavior: ItemBehavior<Record<string, never>, Record<string, never>> = {
      behaviorType: "test.tint",
      stateVersion: 1,
      subscribes: ["tick"],
      initialState: () => ({}),
      onEvent: (_context, _config, state) => ({
        state: state as Record<string, never>,
        commands: [{ type: "setSpriteTint", tint: 0x2a7fff, persistent: true }],
      }),
    };
    const tintedDefinition: ItemDefinition = {
      ...ballDefinition,
      definitionId: "test-tinted",
      behaviorType: tintBehavior.behaviorType,
      defaultConfig: {},
    };
    const simulation = new HostSimulation(
      rocketCanvas,
      [tintedDefinition],
      new BehaviorRegistry().register(tintBehavior),
      60,
    );
    simulation.addItem(instance("tinted-1", tintedDefinition, 50, 20));
    simulation.step();

    expect(simulation.world.registry.require("tinted-1").render?.tint).toBe(0x2a7fff);
    expect(simulation.snapshot().items[0]?.visualTint).toBe(0x2a7fff);
    simulation.free();
  });

  it("drops a crate onto the ground and stops it there", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    for (let i = 0; i < 300; i++) simulation.step();

    const crate = simulation.world.registry.require("crate-1");
    expect(crate.transform.y).toBeGreaterThan(55);
    expect(crate.transform.y).toBeLessThan(70);
    expect(Math.abs(crate.rigidBody!.velocity.y)).toBeLessThan(1);
    simulation.free();
  });

  // The avatar body is kinematic, so the solver never stops it. These cases
  // prove that the character controller does.
  const drivenAvatar = (direction: { x: number; y: number }, steps = 240) => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 55 },
    });
    simulation.world.setAvatarInput("avatar:a", direction, 1, 1);
    for (let i = 0; i < steps; i++) simulation.step();
    const avatar = simulation.world.registry.require("avatar:a");
    const transform = { ...avatar.transform };
    simulation.free();
    return transform;
  };

  // Addendum A3. The left and the right edge return the body after a delay.
  it("returns an avatar to the spawn point after it leaves the left edge", () => {
    const transform = drivenAvatar({ x: -1, y: 0 });
    expect(transform.x).toBeCloseTo(50, 1);
  });

  it("returns an avatar to the spawn point after it leaves the right edge", () => {
    const transform = drivenAvatar({ x: 1, y: 0 });
    expect(transform.x).toBeCloseTo(50, 1);
  });

  it("stops an avatar on the ground instead of below the bottom edge", () => {
    // The ground rect spans y 66 to 70. The avatar radius is 1.2. The floor is
    // the one collider of this canvas that blocks an avatar (addendum A4).
    const transform = drivenAvatar({ x: 0, y: 1 });
    expect(transform.y).toBeLessThan(66);
    expect(transform.y).toBeGreaterThan(62);
  });

  /**
   * Addendum A3. The body is out of the scene for the whole delay, and it is
   * back on the spawn point afterwards. The canvas states two seconds.
   */
  it("hides an avatar for the respawn delay and then places it on the spawn", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 55 },
    });
    simulation.world.setAvatarInput("avatar:a", { x: -1, y: 0 }, 1, 1);

    const avatar = () => simulation.world.registry.require("avatar:a");
    let startTick = -1;
    for (let i = 0; i < 400 && startTick < 0; i++) {
      const events = simulation.world.step().events;
      if (events.some((event) => event.type === "respawn.start")) startTick = i;
    }
    expect(startTick).toBeGreaterThan(0);
    expect(avatar().respawning).toBe(true);

    // One second into the wait the avatar is still out of the scene.
    for (let i = 0; i < 60; i++) simulation.step();
    expect(avatar().respawning).toBe(true);

    // The delay is two seconds, so 90 more ticks pass the end of it.
    let ended = false;
    for (let i = 0; i < 90 && !ended; i++) {
      ended = simulation.world
        .step()
        .events.some((event) => event.type === "respawn.end");
    }
    expect(ended).toBe(true);
    expect(avatar().respawning).toBe(false);
    expect(avatar().transform.x).toBeCloseTo(50, 1);
    expect(avatar().transform.y).toBeCloseTo(62, 1);
    simulation.free();
  });

  /**
   * Addendum A4. Terrain blocks an item by default and lets an avatar through.
   * The hill of this canvas states no rule, so it takes the canvas default.
   */
  it("lets an avatar walk through the hill that still stops a crate", () => {
    const simulation = build();
    // The hill peak is at x 22, y 52. Start to the right of it, level with it.
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 34, y: 62 },
    });
    simulation.world.setAvatarInput("avatar:a", { x: -1, y: 0 }, 1, 1);
    for (let i = 0; i < 60; i++) simulation.step();
    const avatar = simulation.world.registry.require("avatar:a");
    // Without the pass-through rule the hill face stops the avatar near x 30.
    expect(avatar.transform.x).toBeLessThan(20);

    // The same hill still holds a crate above the ground.
    const second = build();
    second.addItem(instance("crate-1", crateDefinition as ItemDefinition, 22, 30));
    for (let i = 0; i < 300; i++) second.step();
    const crate = second.world.registry.require("crate-1");
    expect(crate.transform.y).toBeLessThan(56);
    simulation.free();
    second.free();
  });

  /**
   * Addendum A2. A wrap is a jump. The epoch tells a renderer to snap the
   * sprite rather than slide it back across the whole canvas.
   */
  it("raises the teleport epoch when a body wraps across the top edge", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 10 },
    });
    const before = simulation.world.registry.require("avatar:a").teleportEpoch ?? 0;
    simulation.world.setAvatarInput("avatar:a", { x: 0, y: -1 }, 1, 1);
    let wrapped = false;
    for (let i = 0; i < 240 && !wrapped; i++) {
      simulation.step();
      wrapped = simulation.world.registry.require("avatar:a").transform.y > 40;
    }
    expect(wrapped).toBe(true);
    const after = simulation.world.registry.require("avatar:a").teleportEpoch ?? 0;
    expect(after).toBeGreaterThan(before);
    simulation.free();
  });

  // Addendum A1. A disabled avatar keeps its place and takes no part in the
  // simulation.
  it("stops a disabled avatar and lets an item pass through it", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 40 },
    });
    simulation.world.setAvatarDisabled("avatar:a", true);
    simulation.world.setAvatarInput("avatar:a", { x: 1, y: 0 }, 1, 4);
    // A crate falls from directly above the avatar.
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    for (let i = 0; i < 300; i++) simulation.step();

    const avatar = simulation.world.registry.require("avatar:a");
    expect(avatar.transform.x).toBeCloseTo(50, 3);
    expect(avatar.transform.y).toBeCloseTo(40, 3);
    expect(avatar.avatar!.disabled).toBe(true);
    // The crate reached the ground, so the avatar did not block it.
    expect(simulation.world.registry.require("crate-1").transform.y).toBeGreaterThan(55);
    simulation.free();
  });

  it("moves a re-enabled avatar again from the same place", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 40 },
    });
    simulation.world.setAvatarDisabled("avatar:a", true);
    simulation.world.setAvatarInput("avatar:a", { x: 1, y: 0 }, 1, 1);
    for (let i = 0; i < 60; i++) simulation.step();
    const held = simulation.world.registry.require("avatar:a").transform.x;

    simulation.world.setAvatarDisabled("avatar:a", false);
    simulation.world.setAvatarInput("avatar:a", { x: 1, y: 0 }, 1, 2);
    for (let i = 0; i < 60; i++) simulation.step();
    const avatar = simulation.world.registry.require("avatar:a");
    expect(held).toBeCloseTo(50, 3);
    expect(avatar.transform.x).toBeGreaterThan(55);
    simulation.free();
  });

  it("ends a contact when the avatar is disabled", () => {
    const simulation = build();
    simulation.addItem(instance("rocket-1", rocketDefinition as ItemDefinition, 70, 61));
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 66, y: 62 },
    });
    for (let i = 0; i < 30; i++) simulation.step();
    const slot = () => simulation.behaviors.slot("rocket-1")!.state as { phase: string };
    expect(slot().phase).toBe("arming");

    simulation.world.setAvatarDisabled("avatar:a", true);
    const events = simulation.world.step().events;
    const counts = events.filter(
      (event) => event.type === "contact.count" && event.self === "rocket-1",
    );
    expect(counts.length).toBeGreaterThan(0);
    expect((counts[0] as { count: number }).count).toBe(0);
    expect(
      events.some((event) => event.type === "contact.exit" && event.self === "rocket-1"),
    ).toBe(true);
    simulation.free();
  });

  it("wraps an avatar that leaves the top edge and lands on the ground", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 10 },
    });
    simulation.world.setAvatarInput("avatar:a", { x: 0, y: -1 }, 1, 1);
    let wrapped = false;
    for (let i = 0; i < 240 && !wrapped; i++) {
      simulation.step();
      wrapped = simulation.world.registry.require("avatar:a").transform.y > 40;
    }
    expect(wrapped).toBe(true);
    const avatar = simulation.world.registry.require("avatar:a");
    expect(avatar.transform.y).toBeLessThan(70);
    simulation.free();
  });

  it("wraps a body across the top edge and keeps its velocity", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 5));
    simulation.world.setVelocity("crate-1", { x: 0, y: -10 });
    let wrapped = false;
    for (let i = 0; i < 120 && !wrapped; i++) {
      simulation.step();
      wrapped = simulation.world.registry.require("crate-1").transform.y > 60;
    }
    expect(wrapped).toBe(true);

    // The body must arrive above the ground, not inside it and not below the
    // solid bottom edge.
    const crate = simulation.world.registry.require("crate-1");
    expect(crate.transform.y).toBeLessThan(66);
    for (let i = 0; i < 120; i++) simulation.step();
    expect(simulation.world.registry.require("crate-1").transform.y).toBeLessThan(70);
    simulation.free();
  });

  it("reduces gravity in the space region", () => {
    const simulation = build();
    simulation.addItem(instance("low", crateDefinition as ItemDefinition, 50, 55));
    simulation.addItem(instance("high", crateDefinition as ItemDefinition, 50, 10));
    // One step of free fall from rest, so the change comes from gravity alone.
    simulation.step();
    const low = simulation.world.registry.require("low").rigidBody!.velocity.y;
    const high = simulation.world.registry.require("high").rigidBody!.velocity.y;
    expect(low).toBeGreaterThan(high * 3);
    simulation.free();
  });

  it("runs the rocket workflow: arm, countdown, launch, and space", () => {
    const simulation = build();
    simulation.addItem(instance("rocket-1", rocketDefinition as ItemDefinition, 70, 61));
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 66, y: 62 },
    });
    // Let the bodies settle and the arm sensor register the avatar.
    for (let i = 0; i < 30; i++) simulation.step();

    const slot = () => simulation.behaviors.slot("rocket-1")!.state as { phase: string };
    expect(slot().phase).toBe("arming");

    // The countdown is three seconds at 60 Hz.
    for (let i = 0; i < 200; i++) simulation.step();
    expect(["flying", "spaceDrift", "falling", "landed"]).toContain(slot().phase);

    const rocket = simulation.world.registry.require("rocket-1");
    // The launch impulse points along the rocket nose, which is upward.
    expect(rocket.transform.y).toBeLessThan(58);
    simulation.free();
  });

  it("moves a ball when an avatar runs into its kick sensor", () => {
    const simulation = build();
    simulation.addItem(instance("ball-1", ballDefinition as ItemDefinition, 50, 65));
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 42, y: 65 },
    });
    simulation.world.setAvatarInput("avatar:a", { x: 1, y: 0 }, 1, 1);

    const startX = simulation.world.registry.require("ball-1").transform.x;
    for (let i = 0; i < 180; i++) simulation.step();
    const endX = simulation.world.registry.require("ball-1").transform.x;

    expect(endX).toBeGreaterThan(startX + 1);
    const state = simulation.behaviors.slot("ball-1")!.state as { kickCount: number };
    expect(state.kickCount).toBeGreaterThan(0);
    simulation.free();
  });

  it("accepts simultaneous pushes from two participant avatars", () => {
    const simulation = build();
    simulation.addItem(instance("shared-ball", ballDefinition as ItemDefinition, 50, 65));
    simulation.addAvatar({
      entityId: "avatar:alice",
      clientId: "alice",
      userId: "alice",
      position: { x: 42, y: 65 },
    });
    simulation.addAvatar({
      entityId: "avatar:bob",
      clientId: "bob",
      userId: "bob",
      position: { x: 58, y: 65 },
    });
    simulation.world.setAvatarInput("avatar:alice", { x: 1, y: 0 }, 1, 1);
    simulation.world.setAvatarInput("avatar:bob", { x: -1, y: 0 }, 1, 1);

    for (let i = 0; i < 180; i++) simulation.step();

    const state = simulation.behaviors.slot("shared-ball")!.state as {
      cooldownUntil: [string, number][];
      kickCount: number;
    };
    expect(state.kickCount).toBeGreaterThanOrEqual(2);
    expect(state.cooldownUntil.map(([entityId]) => entityId)).toEqual([
      "avatar:alice",
      "avatar:bob",
    ]);
    simulation.free();
  });

  // Spec 20. A body pushed into terrain must not stay there.
  it("frees a body that a teleport left inside the ground", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    for (let i = 0; i < 5; i++) simulation.step();
    // The ground rect spans y 66 to 70. Place the crate in the middle of it.
    simulation.world.teleport("crate-1", { x: 50, y: 68 }, 0, { x: 0, y: 0 });

    let freed = false;
    for (let i = 0; i < 120 && !freed; i++) {
      const events = simulation.world.step().events;
      freed = events.some((event) => event.type === "unstuck" && event.self === "crate-1");
    }
    expect(freed).toBe(true);

    // The crate now rests on the ground rather than inside it.
    for (let i = 0; i < 120; i++) simulation.step();
    const crate = simulation.world.registry.require("crate-1");
    expect(crate.transform.y).toBeLessThan(66);
    expect(crate.transform.y).toBeGreaterThan(55);
    simulation.free();
  });

  it("quarantines a body that left the canvas by a wide margin", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    simulation.world.teleport("crate-1", { x: 5000, y: 20 }, 0, { x: 0, y: 0 });
    simulation.step();

    const crate = simulation.world.registry.require("crate-1");
    expect(crate.quarantined).toBe(true);
    expect(crate.transform.x).toBeLessThan(100);
    simulation.free();
  });

  it("produces a snapshot that reloads to the same placement at rest", () => {
    const first = build();
    first.addItem(instance("rocket-1", rocketDefinition as ItemDefinition, 70, 62));
    first.addItem(instance("crate-1", crateDefinition as ItemDefinition, 30, 20));
    for (let i = 0; i < 120; i++) first.step();
    const snapshot = first.normalizeForSleep();
    const crateY = first.world.registry.require("crate-1").transform.y;
    first.free();

    expect(snapshot.normalized).toBe(true);
    expect(snapshot.items).toHaveLength(2);

    const second = build();
    second.loadSnapshot(snapshot);
    second.step();
    const reloaded = second.world.registry.require("crate-1");
    expect(reloaded.transform.y).toBeCloseTo(crateY, 1);
    expect(Math.abs(reloaded.rigidBody!.velocity.y)).toBeLessThan(1);
    expect(second.world.registry.require("rocket-1").ownership?.ownerUserId).toBe("alice");
    second.free();
  });

  it("continues checkpoint metadata and restores a saved visual variant", () => {
    const first = build();
    const snapshot = {
      schemaVersion: 1,
      canvasId: rocketCanvas.id,
      canvasVersion: rocketCanvas.version,
      sceneRevision: 7,
      hostEpoch: 4,
      checkpointRevision: 41,
      tick: 120,
      capturedAt: new Date().toISOString(),
      normalized: false,
      items: [
        {
          entityId: "rocket-1",
          definitionId: rocketDefinition.definitionId,
          definitionVersion: rocketDefinition.version,
          ownerUserId: "alice",
          transform: { x: 70, y: 62, rotation: 0 },
          resolvedConfig: resolveItemConfig(
            rocketDefinition as ItemDefinition<Record<string, unknown>>,
            {
              width: rocketCanvas.size.width,
              height: rocketCanvas.size.height,
              orientation: rocketCanvas.orientation,
            },
          ),
          visualVariant: "armed",
        },
      ],
    };
    first.loadSnapshot(snapshot);

    expect(first.world.registry.require("rocket-1").render?.variant).toBe("armed");
    expect(first.snapshot(false, { sceneRevision: 7, hostEpoch: 4 })).toMatchObject({
      sceneRevision: 7,
      hostEpoch: 4,
      checkpointRevision: 42,
    });
    first.free();
  });

  it("writes the loaded item definition version instead of a hard-coded version", () => {
    const versionedCrate = { ...crateDefinition, version: 7 };
    const definitions = rocketCanvasDefinitions.map((definition) =>
      definition.definitionId === versionedCrate.definitionId
        ? versionedCrate
        : definition,
    );
    const simulation = new HostSimulation(rocketCanvas, definitions, registry(), 60);
    simulation.addItem(
      instance("crate-1", versionedCrate as ItemDefinition, 50, 20),
    );

    expect(simulation.snapshot().items[0]?.definitionVersion).toBe(7);
    simulation.free();
  });

  it("scales item visuals and collider geometry as one persisted transform", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    simulation.world.setScale("crate-1", 2);
    for (let i = 0; i < 300; i++) simulation.step();

    const crate = simulation.world.registry.require("crate-1");
    // The ground starts at y=66. A doubled 3-unit collider rests with its
    // centre roughly 3 units above it rather than the default 1.5.
    expect(crate.transform.y).toBeGreaterThan(62);
    expect(crate.transform.y).toBeLessThan(64);
    expect(simulation.snapshot().items[0]?.transform.scale).toBe(2);
    simulation.free();
  });

  it("applies resolved config changes to the live behavior and its checkpoint", () => {
    const simulation = build();
    simulation.addItem(
      instance("rocket-1", rocketDefinition as ItemDefinition, 70, 62),
    );
    const updated = { ...defaultRocketConfig, countdownSeconds: 0.25 };

    simulation.setItemConfig("rocket-1", updated);

    expect(simulation.behaviors.slot("rocket-1")?.config).toEqual(updated);
    expect(simulation.world.registry.require("rocket-1").behavior?.config).toEqual(updated);
    expect(simulation.snapshot().items[0]?.resolvedConfig).toEqual(updated);
    simulation.free();
  });

  it("migrates snapshot behavior state and checkpoints its current version", () => {
    const definition: ItemDefinition = {
      ...crateDefinition,
      definitionId: "migrating-item",
      version: 4,
      behaviorType: "migrating",
      persistence: {
        ...crateDefinition.persistence,
        behaviorState: true,
      },
    };
    const behavior = {
      behaviorType: "migrating",
      stateVersion: 2,
      migrations: new MigrationChain<{ value: number; migrated?: boolean }>(2)
        .step(1, (state) => ({ ...state, migrated: true })),
      initialState: () => ({ value: 0, migrated: true }),
      onEvent: (_ctx, _config, state) => ({ state, commands: [] }),
    } satisfies ItemBehavior<unknown, { value: number; migrated?: boolean }>;
    const simulation = new HostSimulation(
      rocketCanvas,
      [definition],
      new BehaviorRegistry().register(behavior),
      60,
    );
    simulation.loadSnapshot(
      {
        schemaVersion: 1,
        canvasId: rocketCanvas.id,
        canvasVersion: rocketCanvas.version,
        sceneRevision: 1,
        hostEpoch: 1,
        checkpointRevision: 1,
        tick: 10,
        capturedAt: new Date().toISOString(),
        normalized: false,
        items: [
          {
            entityId: "item-1",
            definitionId: definition.definitionId,
            definitionVersion: definition.version,
            ownerUserId: "alice",
            transform: { x: 50, y: 20, rotation: 0 },
            resolvedConfig: {},
            behaviorState: { value: 7 },
            behaviorStateVersion: 1,
          },
        ],
      },
      false,
    );

    expect(simulation.behaviors.slot("item-1")).toMatchObject({
      state: { value: 7, migrated: true },
      stateVersion: 2,
    });
    expect(simulation.snapshot().items[0]).toMatchObject({
      definitionVersion: 4,
      behaviorState: { value: 7, migrated: true },
      behaviorStateVersion: 2,
    });
    simulation.free();
  });

  it("resumes an active migration snapshot without applying room wake", () => {
    const simulation = build();
    const snapshot = {
      schemaVersion: 1,
      canvasId: rocketCanvas.id,
      canvasVersion: rocketCanvas.version,
      sceneRevision: 8,
      hostEpoch: 5,
      checkpointRevision: 42,
      tick: 321,
      capturedAt: new Date().toISOString(),
      normalized: false,
      items: [
        {
          entityId: "rocket-1",
          definitionId: rocketDefinition.definitionId,
          definitionVersion: rocketDefinition.version,
          ownerUserId: "alice",
          transform: { x: 70, y: 40, rotation: 0 },
          resolvedConfig: resolveItemConfig(
            rocketDefinition as ItemDefinition<Record<string, unknown>>,
            {
              width: rocketCanvas.size.width,
              height: rocketCanvas.size.height,
              orientation: rocketCanvas.orientation,
            },
          ),
          behaviorState: {
            phase: "flying" as const,
            armedAtTick: 100,
            countdownTicks: 180,
            qualifyingContacts: 1,
            thrustTicksRemaining: 30,
            launchCount: 2,
          },
          behaviorStateVersion: 1,
          visualVariant: "flying",
        },
      ],
    };

    simulation.loadSnapshot(snapshot, false);
    simulation.step();

    expect(simulation.tick).toBe(322);
    expect(simulation.behaviors.slot("rocket-1")?.state).toMatchObject({
      phase: "flying",
      launchCount: 2,
    });
    expect(simulation.world.registry.require("rocket-1").render?.variant).toBe("flying");
    simulation.free();
  });

  it("restores the remaining behavior timer across active host migration", () => {
    const simulation = build();
    const snapshot = {
      schemaVersion: 1,
      canvasId: rocketCanvas.id,
      canvasVersion: rocketCanvas.version,
      sceneRevision: 9,
      hostEpoch: 6,
      checkpointRevision: 43,
      tick: 400,
      capturedAt: new Date().toISOString(),
      normalized: false,
      items: [
        {
          entityId: "rocket-1",
          definitionId: rocketDefinition.definitionId,
          definitionVersion: rocketDefinition.version,
          ownerUserId: "alice",
          transform: { x: 70, y: 62, rotation: 0 },
          resolvedConfig: resolveItemConfig(
            rocketDefinition as ItemDefinition<Record<string, unknown>>,
            {
              width: rocketCanvas.size.width,
              height: rocketCanvas.size.height,
              orientation: rocketCanvas.orientation,
            },
          ),
          behaviorState: {
            phase: "arming" as const,
            armedAtTick: 280,
            countdownTicks: 180,
            qualifyingContacts: 1,
            thrustTicksRemaining: 0,
            launchCount: 0,
          },
          behaviorStateVersion: 1,
          behaviorTimers: [
            { key: "countdown", elapsedTicks: 120, remainingTicks: 2 },
          ],
          visualVariant: "arming",
        },
      ],
    };

    simulation.loadSnapshot(snapshot, false);
    simulation.step();
    expect(simulation.behaviors.slot("rocket-1")?.state).toMatchObject({
      phase: "arming",
    });
    simulation.step();
    expect(simulation.behaviors.slot("rocket-1")?.state).toMatchObject({
      phase: "flying",
      launchCount: 1,
    });
    simulation.free();
  });

  it("reports only the entities whose transform changed", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    simulation.step();
    expect(simulation.changedEntities().map((e) => e.id)).toContain("crate-1");

    // Let the crate settle, then confirm it stops appearing in deltas.
    for (let i = 0; i < 400; i++) simulation.step();
    simulation.changedEntities();
    simulation.step();
    expect(simulation.changedEntities()).toHaveLength(0);
    simulation.free();
  });

  it("quarantines an entity with a non-finite transform", () => {
    const simulation = build();
    simulation.addItem(instance("crate-1", crateDefinition as ItemDefinition, 50, 20));
    simulation.world.teleport("crate-1", { x: Number.NaN, y: 10 });
    simulation.step();
    const crate = simulation.world.registry.require("crate-1");
    expect(crate.quarantined).toBe(true);
    expect(Number.isFinite(crate.transform.x)).toBe(true);
    simulation.free();
  });
});
