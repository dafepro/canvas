import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CollisionLayer,
  BehaviorRegistry,
  validateCanvasDefinition,
  type CanvasDefinition,
  type ItemInstance,
} from "@canvas-physics/core";
import { BehaviorTestHarness } from "@canvas-physics/core/testing";
import {
  HostSimulation,
  RapierWorld,
  validateAssetReferences,
} from "@canvas-physics/client";
import canvasJson from "../server/canvases/item-playground.json";
import emojiJson from "../server/definitions/emoji-party.json";
import photoJson from "../server/definitions/photo-card.json";
import orbJson from "../server/definitions/reactive-orb.json";
import stampJson from "../server/definitions/system-stamp.json";
import bouncerJson from "../server/definitions/live-bouncer.json";
import colorTileJson from "../server/definitions/color-tile.json";
import pairedPortalJson from "../server/definitions/paired-portal.json";
import antigravityFieldJson from "../server/definitions/antigravity-field.json";
import blackHoleJson from "../server/definitions/black-hole.json";
import { playgroundAssets } from "../src/assets.js";
import {
  playgroundDefinitions,
  playgroundAvatarDefinition,
  antigravityFieldDefinition,
  blackHoleDefinition,
  liveBouncerDefinition,
  pairedPortalDefinition,
  reactiveOrbDefinition,
} from "../src/content.js";
import {
  ReactiveOrbBehavior,
  defaultReactiveOrbConfig,
} from "../src/reactive-orb-behavior.js";
import { LiveBouncerBehavior } from "../src/live-bouncer-behavior.js";
import {
  PairedPortalBehavior,
  defaultPairedPortalConfig,
} from "../src/paired-portal-behavior.js";
import {
  ForceFieldBehavior,
  antigravityFieldConfig,
  blackHoleFieldConfig,
} from "../src/force-field-behavior.js";

const canvas = canvasJson as unknown as CanvasDefinition;

beforeAll(async () => {
  await RapierWorld.load();
}, 30_000);

describe("compact item playground", () => {
  it("keeps the independently served scene intentionally small", () => {
    expect(validateCanvasDefinition(canvas)).toEqual({ ok: true });
    expect(canvas.size).toEqual({ width: 36, height: 24 });
    expect(canvas.limits.maxItems).toBeGreaterThanOrEqual(30);
    expect(canvas.systemItems).toEqual([
      expect.objectContaining({
        entityId: "room-owned-stamp",
        definitionId: "system-stamp",
      }),
      expect.objectContaining({
        entityId: "always-live-ball",
        definitionId: "live-bouncer",
      }),
    ]);
  });

  it("keeps client definitions, server contracts, and consumer assets aligned", () => {
    const serverDefinitions = [
      emojiJson,
      photoJson,
      orbJson,
      stampJson,
      bouncerJson,
      colorTileJson,
      pairedPortalJson,
      antigravityFieldJson,
      blackHoleJson,
    ];
    for (const definition of playgroundDefinitions.filter(
      ({ definitionId }) => definitionId !== "avatar",
    )) {
      const server = serverDefinitions.find(
        ({ definitionId }) => definitionId === definition.definitionId,
      );
      expect(server, definition.definitionId).toBeDefined();
      expect(server?.version).toBe(definition.version);
      expect(server?.visual).toEqual(definition.visual);
      expect(server?.defaultConfig).toEqual(definition.defaultConfig);
    }

    expect(validateAssetReferences(playgroundAssets, canvas, playgroundDefinitions)).toEqual([]);
    expect(playgroundAvatarDefinition.visual.spriteId).toBe("playground.avatar.maker");
  });

  it("keeps direct manipulation controls around the selected item", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(html).toContain('class="scale-tools"');
    expect(html).toContain('class="rotate-control rotate-left"');
    expect(html).toContain('class="rotate-control rotate-right"');
    expect(html).toContain('id="more-toggle"');
    expect(html).toContain('id="finish-edit"');
    expect(html).toContain('id="custom-color-picker"');
    expect(html).toContain('id="collisions"');
    expect(html).toContain('data-spawn="paired-portal"');
    expect(html).toContain('data-spawn="antigravity-field"');
    expect(html).toContain('data-spawn="black-hole"');
    expect(html).toContain('data-highlight="aurora"');
    expect(html).toContain('aria-label="Delete item"');
    expect(main).toContain("Finished editing · frozen state preserved");
    expect(main).not.toContain("runtime!.setItemIsolation(entity.id, false)");
    expect(main).toContain("runtime?.selectItemForEdit(entity.id)");
    expect(main).not.toContain("selectedEntityId = spawned.id");
  });

  it("applies an arbitrary consumer color as a replicated sprite tint", () => {
    const harness = new BehaviorTestHarness(
      ReactiveOrbBehavior,
      { theme: "custom", customColor: "#2a7fff" },
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );

    harness.advance();
    expect(harness.host.body(harness.entityId).variant).toBe("custom");
    expect(harness.host.body(harness.entityId).tint).toBe(0x2a7fff);
  });

  it("applies configured color and plays an effect on avatar contact", () => {
    const harness = new BehaviorTestHarness(
      ReactiveOrbBehavior,
      { ...defaultReactiveOrbConfig, theme: "coral" },
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );

    harness.advance();
    expect(harness.host.body(harness.entityId).variant).toBe("coral");

    harness.send({
      type: "contact.enter",
      selfColliderId: "touch",
      other: {
        entityId: "avatar:visitor",
        colliderId: "body",
        kind: "avatar",
        tags: [],
        userId: "visitor",
      },
    }).advance(1, false);

    expect(harness.host.body(harness.entityId).animation).toBe("pulse");
    expect(harness.host.effects).toEqual([
      expect.objectContaining({ effect: "portalFlash", mode: "oneShot" }),
    ]);
    expect(harness.state.activations).toBe(1);
  });

  it("reacts when a real avatar enters the orb touch sensor", () => {
    const simulation = new HostSimulation(
      canvas,
      playgroundDefinitions,
      new BehaviorRegistry()
        .register(ReactiveOrbBehavior)
        .register(LiveBouncerBehavior),
      60,
    );
    const orb: ItemInstance = {
      entityId: "orb-contact",
      canvasId: canvas.id,
      definitionId: reactiveOrbDefinition.definitionId,
      definitionVersion: reactiveOrbDefinition.version,
      ownerUserId: "maker",
      transform: { x: 18, y: 12, rotation: 0 },
      resolvedConfig: defaultReactiveOrbConfig,
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    };
    simulation.addItem(orb);
    simulation.addAvatar({
      entityId: "avatar:visitor",
      clientId: "visitor-client",
      userId: "visitor",
      position: { x: 18, y: 20 },
    });

    simulation.world.setAvatarInput("avatar:visitor", { x: 0, y: -1 }, 1, 1);
    const effects = [];
    for (let tick = 0; tick < 90; tick++) effects.push(...simulation.step().effects);
    const entity = simulation.world.registry.require(orb.entityId);

    expect(simulation.behaviors.slot(orb.entityId)?.state).toMatchObject({ activations: 1 });
    expect(entity.render).toMatchObject({ animation: "pulse", animationEpoch: 1 });
    expect(effects).toEqual([
      expect.objectContaining({
        entityId: orb.entityId,
        effect: "portalFlash",
        mode: "oneShot",
      }),
    ]);
    simulation.free();
  });

  it("routes either portal endpoint through the opposite side without ping-pong", () => {
    const harness = new BehaviorTestHarness(
      PairedPortalBehavior,
      defaultPairedPortalConfig,
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );
    harness.host.body(harness.entityId).transform = { x: 18, y: 12, rotation: 0 };
    harness.host.body("avatar:traveler").transform = { x: 13.7, y: 12, rotation: 0 };
    harness.host.body("avatar:traveler").velocity = { x: 7, y: 0 };

    harness.send({
      type: "contact.enter",
      selfColliderId: "left-portal",
      other: {
        entityId: "avatar:traveler",
        colliderId: "sensor",
        kind: "avatar",
        tags: [],
        userId: "traveler",
      },
    }).flush();

    expect(harness.host.body("avatar:traveler").transform).toMatchObject({ x: 26, y: 12 });
    expect(harness.host.body("avatar:traveler").velocity).toEqual({ x: 7, y: 0 });
    expect(harness.host.body(harness.entityId).animation).toBe("surge");
    expect(harness.host.effects).toEqual([
      expect.objectContaining({
        entityId: "avatar:traveler",
        effect: "portalFlash",
        mode: "oneShot",
      }),
    ]);
    expect(harness.state.transitCount).toBe(1);

    harness.send({
      type: "contact.enter",
      selfColliderId: "right-portal",
      other: {
        entityId: "avatar:traveler",
        colliderId: "sensor",
        kind: "avatar",
        tags: [],
        userId: "traveler",
      },
    }).flush();
    expect(harness.state.transitCount).toBe(1);
  });

  it("teleports a real avatar through the composite portal item", () => {
    const simulation = new HostSimulation(
      canvas,
      playgroundDefinitions,
      new BehaviorRegistry()
        .register(ReactiveOrbBehavior)
        .register(LiveBouncerBehavior)
        .register(PairedPortalBehavior),
      60,
    );
    simulation.addItem({
      entityId: "portal-pair",
      canvasId: canvas.id,
      definitionId: pairedPortalDefinition.definitionId,
      definitionVersion: pairedPortalDefinition.version,
      ownerUserId: "maker",
      transform: { x: 18, y: 12, rotation: 0 },
      resolvedConfig: defaultPairedPortalConfig,
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });
    simulation.addAvatar({
      entityId: "avatar:traveler",
      clientId: "traveler-client",
      userId: "traveler",
      position: { x: 7, y: 12 },
    });
    simulation.world.setAvatarInput("avatar:traveler", { x: 1, y: 0 }, 1, 1);

    const effects = [];
    for (let tick = 0; tick < 90; tick++) effects.push(...simulation.step().effects);
    const avatar = simulation.world.registry.require("avatar:traveler");

    expect(avatar.transform.x).toBeGreaterThan(24);
    expect(avatar.teleportEpoch).toBe(1);
    expect(simulation.behaviors.slot("portal-pair")?.state).toMatchObject({ transitCount: 1 });
    expect(effects).toContainEqual(
      expect.objectContaining({
        entityId: "avatar:traveler",
        effect: "portalFlash",
        mode: "oneShot",
      }),
    );
    simulation.free();
  });

  it("teleports a real dynamic item through the composite portal item", () => {
    const simulation = new HostSimulation(
      canvas,
      playgroundDefinitions,
      new BehaviorRegistry()
        .register(ReactiveOrbBehavior)
        .register(LiveBouncerBehavior)
        .register(PairedPortalBehavior),
      60,
    );
    simulation.addItem({
      entityId: "portal-pair",
      canvasId: canvas.id,
      definitionId: pairedPortalDefinition.definitionId,
      definitionVersion: pairedPortalDefinition.version,
      ownerUserId: "maker",
      transform: { x: 18, y: 12, rotation: 0 },
      resolvedConfig: defaultPairedPortalConfig,
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });
    simulation.addItem({
      entityId: "traveling-ball",
      canvasId: canvas.id,
      definitionId: liveBouncerDefinition.definitionId,
      definitionVersion: liveBouncerDefinition.version,
      ownerUserId: "",
      transform: { x: 7, y: 12, rotation: 0 },
      resolvedConfig: { speed: 8.5, initialDirection: { x: 1, y: 0 } },
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });

    const effects = [];
    for (
      let tick = 0;
      tick < 70 && (simulation.world.registry.require("traveling-ball").teleportEpoch ?? 0) === 0;
      tick++
    ) {
      effects.push(...simulation.step().effects);
    }
    const ball = simulation.world.registry.require("traveling-ball");

    expect(ball.transform.x).toBeGreaterThan(24);
    expect(ball.teleportEpoch).toBe(1);
    expect(simulation.behaviors.slot("portal-pair")?.state).toMatchObject({ transitCount: 1 });
    expect(effects).toContainEqual(
      expect.objectContaining({
        entityId: "traveling-ball",
        effect: "portalFlash",
        mode: "oneShot",
      }),
    );
    simulation.free();
  });

  it("authors directional and radial acceleration with sensor-only behaviors", () => {
    expect(antigravityFieldDefinition.colliders.every(({ role }) => role.endsWith("Sensor")))
      .toBe(true);
    expect(blackHoleDefinition.colliders.every(({ role }) => role.endsWith("Sensor"))).toBe(true);
    const lift = new BehaviorTestHarness(
      ForceFieldBehavior,
      antigravityFieldConfig,
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );
    lift.send({
      type: "contact.stay",
      selfColliderId: "field",
      other: { entityId: "ball", colliderId: "solid", kind: "item", tags: [] },
      dwellTicks: 1,
    }).flush();
    expect(lift.commands("applyForce")).toEqual([
      expect.objectContaining({ target: "ball", force: { x: 0, y: -18 } }),
    ]);

    const gravity = new BehaviorTestHarness(
      ForceFieldBehavior,
      blackHoleFieldConfig,
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );
    gravity.host.body(gravity.entityId).transform = { x: 18, y: 12, rotation: 0 };
    gravity.host.body("ball").transform = { x: 12, y: 8, rotation: 0 };
    gravity.send({
      type: "contact.stay",
      selfColliderId: "field",
      other: { entityId: "ball", colliderId: "solid", kind: "item", tags: [] },
      dwellTicks: 1,
    }).flush();
    const radialForce = gravity.commands("applyForce")[0]?.force;
    expect(radialForce?.x).toBeGreaterThan(0);
    expect(radialForce?.y).toBeGreaterThan(0);
    expect(Math.hypot(radialForce?.x ?? 0, radialForce?.y ?? 0)).toBeCloseTo(
      450 / (52 + 1.5 ** 2),
    );
  });

  it("pushes the live ball upward without a solid collision", () => {
    const simulation = new HostSimulation(
      canvas,
      playgroundDefinitions,
      new BehaviorRegistry()
        .register(ForceFieldBehavior)
        .register(LiveBouncerBehavior),
      60,
    );
    simulation.addItem({
      entityId: "lift-field",
      canvasId: canvas.id,
      definitionId: antigravityFieldDefinition.definitionId,
      definitionVersion: antigravityFieldDefinition.version,
      ownerUserId: "maker",
      transform: { x: 18, y: 12, rotation: 0 },
      resolvedConfig: antigravityFieldConfig,
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });
    simulation.addItem({
      entityId: "lifted-ball",
      canvasId: canvas.id,
      definitionId: liveBouncerDefinition.definitionId,
      definitionVersion: liveBouncerDefinition.version,
      ownerUserId: "",
      transform: { x: 18, y: 15, rotation: 0 },
      resolvedConfig: { speed: 8.5, initialDirection: { x: 1, y: 0 } },
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });

    for (let tick = 0; tick < 35; tick++) simulation.step();
    const ball = simulation.world.registry.require("lifted-ball");
    expect(ball.transform.y).toBeLessThan(14);
    expect(ball.rigidBody?.velocity.y).toBeLessThan(-2);
    simulation.free();
  });

  it("bends the live ball trajectory toward a black-hole centre", () => {
    const simulation = new HostSimulation(
      canvas,
      playgroundDefinitions,
      new BehaviorRegistry()
        .register(ForceFieldBehavior)
        .register(LiveBouncerBehavior),
      60,
    );
    simulation.addItem({
      entityId: "gravity-field",
      canvasId: canvas.id,
      definitionId: blackHoleDefinition.definitionId,
      definitionVersion: blackHoleDefinition.version,
      ownerUserId: "maker",
      transform: { x: 18, y: 12, rotation: 0 },
      resolvedConfig: blackHoleFieldConfig,
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });
    simulation.addItem({
      entityId: "curved-ball",
      canvasId: canvas.id,
      definitionId: liveBouncerDefinition.definitionId,
      definitionVersion: liveBouncerDefinition.version,
      ownerUserId: "",
      transform: { x: 12, y: 8, rotation: 0 },
      resolvedConfig: { speed: 8.5, initialDirection: { x: 1, y: 0 } },
      createdAt: new Date().toISOString(),
      sceneRevision: 1,
    });

    for (let tick = 0; tick < 20; tick++) simulation.step();
    const ball = simulation.world.registry.require("curved-ball");
    expect(ball.transform.y).toBeGreaterThan(8.3);
    expect(ball.rigidBody?.velocity.y).toBeGreaterThan(2);
    simulation.free();
  });

  it("keeps the room-owned demo ball moving without an editor", () => {
    const collisionMask = liveBouncerDefinition.colliders[0]?.collisionMask ?? 0;
    expect(collisionMask & CollisionLayer.WORLD_STATIC).not.toBe(0);
    expect(collisionMask & CollisionLayer.ITEM_SOLID).not.toBe(0);
    const harness = new BehaviorTestHarness(
      LiveBouncerBehavior,
      { speed: 8.5, initialDirection: { x: 7, y: 5 } },
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );

    harness.advance();
    expect(Math.hypot(
      harness.host.body(harness.entityId).velocity.x,
      harness.host.body(harness.entityId).velocity.y,
    )).toBeCloseTo(8.5);
    harness.host.body(harness.entityId).velocity = { x: 1, y: 0 };
    harness.advance();
    expect(harness.host.body(harness.entityId).velocity).toEqual({ x: 8.5, y: 0 });
    harness.host.body(harness.entityId).velocity = { x: 12, y: 0 };
    harness.advance();
    expect(harness.host.body(harness.entityId).velocity).toEqual({ x: 12, y: 0 });
  });
});
