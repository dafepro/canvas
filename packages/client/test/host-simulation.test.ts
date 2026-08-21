import { beforeAll, describe, expect, it } from "vitest";
import {
  BehaviorRegistry,
  KickableBehavior,
  PortalBehavior,
  RocketBehavior,
  resolveItemConfig,
  type ItemDefinition,
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

  it("keeps an avatar inside a solid edge", () => {
    const simulation = build();
    simulation.addAvatar({
      entityId: "avatar:a",
      clientId: "a",
      userId: "alice",
      position: { x: 50, y: 60 },
    });
    // Push hard into the left wall for two seconds.
    simulation.world.setAvatarInput("avatar:a", { x: -1, y: 0 }, 1, 1);
    for (let i = 0; i < 120; i++) simulation.step();

    const avatar = simulation.world.registry.require("avatar:a");
    expect(avatar.transform.x).toBeGreaterThan(-1);
    expect(Number.isFinite(avatar.transform.x)).toBe(true);
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
