import { describe, expect, it } from "vitest";
import {
  EntityRegistry,
  KickableBehavior,
  defaultKickableConfig,
  PortalBehavior,
  defaultPortalConfig,
  explainTuning,
  resolveItemConfig,
  validateCanvasDefinition,
  CollisionLayer,
  resolveTerrainBlocking,
  terrainMask,
  validateItemDefinition,
  validateSnapshot,
  validateTransform,
  emptySnapshot,
  roleDefaultMask,
  CollisionLayer,
  isSensorRole,
  type CanvasDefinition,
  type ItemDefinition,
  type KickableConfig,
  type KickableState,
  type PortalConfig,
  type PortalState,
} from "../src/index.js";
import { BehaviorTestHarness, avatarParty } from "../src/testing/index.js";

const canvas: CanvasDefinition = {
  id: "rocket-canvas",
  version: 1,
  size: { width: 100, height: 70 },
  orientation: "side",
  edges: { top: "wrap", right: "solid", bottom: "solid", left: "solid" },
  staticGeometry: [],
  regions: [],
  environment: { base: { gravityXY: { x: 0, y: 20 }, linearDrag: 0.1 } },
  spawnPoints: [{ id: "centre", position: { x: 50, y: 35 } }],
  systemItems: [],
  limits: { maxAvatars: 20, maxItems: 50, maxComplexPhysicsItems: 5 },
};

const rocketDefinition: ItemDefinition<Record<string, unknown>> = {
  definitionId: "rocket",
  version: 1,
  displayName: "Rocket",
  visual: { size: { width: 3, height: 6 }, placeholder: { shape: "triangle", color: 0xffffff } },
  colliders: [
    { id: "hull", role: "itemSolid", shape: { type: "capsule", halfHeight: 2, radius: 1 } },
    { id: "arm", role: "itemSensor", shape: { type: "circle", radius: 3 } },
  ],
  behaviorType: "rocket",
  defaultConfig: { thrust: 24, maxSpeed: 19, scale: 1 },
  tuningRules: [
    { when: { maxCanvasWidth: 70 }, overrides: { scale: 0.85, thrust: 18, maxSpeed: 14 } },
    { when: { minCanvasWidth: 70 }, overrides: { scale: 1.0, thrust: 24, maxSpeed: 19 } },
  ],
  persistence: { transform: true, behaviorState: true, onRoomSleep: "resetToIdle" },
  complexity: "complex",
};

describe("tuning rules", () => {
  it("resolves the small-canvas overrides", () => {
    const config = resolveItemConfig(rocketDefinition, {
      width: 60,
      height: 40,
      orientation: "side",
    });
    expect(config).toEqual({ thrust: 18, maxSpeed: 14, scale: 0.85 });
  });

  it("resolves the large-canvas overrides", () => {
    const config = resolveItemConfig(rocketDefinition, {
      width: 100,
      height: 70,
      orientation: "side",
    });
    expect(config).toEqual({ thrust: 24, maxSpeed: 19, scale: 1 });
  });

  it("lets a spawn-time override win over every rule", () => {
    const config = resolveItemConfig(
      rocketDefinition,
      { width: 100, height: 70, orientation: "side" },
      { thrust: 30 },
    );
    expect(config.thrust).toBe(30);
  });

  it("matches an orientation condition", () => {
    const matched = explainTuning(
      [{ when: { orientation: "topDown" }, overrides: { drag: 1 } }],
      { width: 100, height: 70, orientation: "side" },
    );
    expect(matched).toHaveLength(0);
  });
});

describe("collision roles", () => {
  it("keeps avatars from colliding with each other", () => {
    expect(roleDefaultMask.avatarBody & CollisionLayer.AVATAR_BODY).toBe(0);
  });

  it("lets an avatar body hit static geometry and solid items", () => {
    expect(roleDefaultMask.avatarBody & CollisionLayer.WORLD_STATIC).toBeGreaterThan(0);
    expect(roleDefaultMask.avatarBody & CollisionLayer.ITEM_SOLID).toBeGreaterThan(0);
  });

  it("classifies sensor roles", () => {
    expect(isSensorRole("itemSensor")).toBe(true);
    expect(isSensorRole("itemSolid")).toBe(false);
  });

  it("lets solid items participate in authored sensor interactions", () => {
    expect(roleDefaultMask.itemSolid & CollisionLayer.ITEM_SENSOR).not.toBe(0);
    expect(roleDefaultMask.itemSolid & CollisionLayer.REGION_SENSOR).not.toBe(0);
    expect(roleDefaultMask.itemSolid & CollisionLayer.PORTAL_SENSOR).not.toBe(0);
  });
});

describe("validation", () => {
  it("accepts the rocket canvas and definition", () => {
    expect(validateCanvasDefinition(canvas)).toEqual({ ok: true });
    expect(validateItemDefinition(rocketDefinition, new Set(["rocket"]))).toEqual({ ok: true });
  });

  it("validates optional canvas-owned avatar movement tuning", () => {
    expect(validateCanvasDefinition({
      ...canvas,
      avatarController: {
        maxSpeed: 26,
        acceleration: 150,
        flickDeceleration: 24,
        maxTurnSpeed: 12,
        facing: "fixed",
        directInteractionMaxSpeed: 30,
      },
    })).toEqual({ ok: true });
    expect(validateCanvasDefinition({
      ...canvas,
      avatarController: {
        maxSpeed: 0,
        acceleration: Number.NaN,
        flickDeceleration: -1,
        maxTurnSpeed: 0,
        facing: "camera" as "fixed",
        directInteractionMaxSpeed: Number.POSITIVE_INFINITY,
      },
    })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "avatarController.maxSpeed" }),
        expect.objectContaining({ path: "avatarController.acceleration" }),
        expect.objectContaining({ path: "avatarController.flickDeceleration" }),
        expect.objectContaining({ path: "avatarController.maxTurnSpeed" }),
        expect.objectContaining({ path: "avatarController.facing" }),
        expect.objectContaining({ path: "avatarController.directInteractionMaxSpeed" }),
      ]),
    });
  });

  it("refuses an unknown behavior type", () => {
    const result = validateItemDefinition(rocketDefinition, new Set(["ball"]));
    expect(result.ok).toBe(false);
  });

  it("refuses duplicate collider ids", () => {
    const broken = {
      ...rocketDefinition,
      colliders: [rocketDefinition.colliders[0]!, rocketDefinition.colliders[0]!],
    };
    const result = validateItemDefinition(broken);
    expect(result.ok).toBe(false);
  });

  it("requires a spawn point for a respawn edge", () => {
    const result = validateCanvasDefinition({
      ...canvas,
      edges: { ...canvas.edges, bottom: "respawn" },
      spawnPoints: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed nested canvas physics before worker initialization", () => {
    const broken = {
      ...canvas,
      orientation: "diagonal" as "side",
      edges: { ...canvas.edges, top: "teleport" as "solid" },
      staticGeometry: [{
        id: "bad-wall",
        shape: { type: "rect" as const, width: 0, height: 2 },
        position: { x: Number.NaN, y: 1 },
        rotation: Number.POSITIVE_INFINITY,
        restitution: 2,
        friction: -1,
      }],
      regions: [{
        id: "bad-region",
        shape: { type: "circle" as const, x: 1, y: 2, radius: 0 },
        fieldModifier: {
          blend: "linear" as const,
          priority: Number.NaN,
          gravityScale: Number.POSITIVE_INFINITY,
        },
      }],
      environment: {
        base: {
          gravityXY: { x: Number.NaN, y: 20 },
          linearDrag: -1,
          angularDrag: Number.POSITIVE_INFINITY,
        },
      },
      spawnPoints: [{ id: "bad-spawn", position: { x: -1, y: Number.NaN } }],
      respawn: { delaySeconds: -1, spawnPointId: "missing" },
    };

    expect(validateCanvasDefinition(broken)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "orientation" }),
        expect.objectContaining({ path: "edges.top" }),
        expect.objectContaining({ path: "staticGeometry[0].shape.width" }),
        expect.objectContaining({ path: "staticGeometry[0].position" }),
        expect.objectContaining({ path: "staticGeometry[0].rotation" }),
        expect.objectContaining({ path: "staticGeometry[0].restitution" }),
        expect.objectContaining({ path: "staticGeometry[0].friction" }),
        expect.objectContaining({ path: "regions[0].shape.radius" }),
        expect.objectContaining({ path: "regions[0].fieldModifier.priority" }),
        expect.objectContaining({ path: "regions[0].fieldModifier.gravityScale" }),
        expect.objectContaining({ path: "environment.base.gravityXY" }),
        expect.objectContaining({ path: "environment.base.linearDrag" }),
        expect.objectContaining({ path: "environment.base.angularDrag" }),
        expect.objectContaining({ path: "spawnPoints[0].position" }),
        expect.objectContaining({ path: "respawn.delaySeconds" }),
        expect.objectContaining({ path: "respawn.spawnPointId" }),
      ]),
    });
  });

  it("rejects item-definition numerics that physics and rendering cannot represent", () => {
    const broken = {
      ...rocketDefinition,
      visual: {
        ...rocketDefinition.visual,
        size: { width: Number.NaN, height: Number.POSITIVE_INFINITY },
        animations: { broken: { frames: ["frame"], fps: 0, loop: true } },
      },
      body: {
        mode: "dynamic" as const,
        mass: 0,
        gravityScale: Number.NaN,
        linearDamping: -1,
      },
      colliders: [{
        ...rocketDefinition.colliders[0]!,
        shape: { type: "circle" as const, radius: 0 },
        offset: { x: Number.NaN, y: 0 },
        rotation: Number.POSITIVE_INFINITY,
        collisionMask: 1.5,
        restitution: 2,
        friction: -1,
        density: Number.NaN,
      }],
    };
    expect(validateItemDefinition(broken)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "visual.size" }),
        expect.objectContaining({ path: "visual.animations.broken.fps" }),
        expect.objectContaining({ path: "body.mass" }),
        expect.objectContaining({ path: "body.gravityScale" }),
        expect.objectContaining({ path: "body.linearDamping" }),
        expect.objectContaining({ path: "colliders[0].shape.radius" }),
        expect.objectContaining({ path: "colliders[0].offset" }),
        expect.objectContaining({ path: "colliders[0].rotation" }),
        expect.objectContaining({ path: "colliders[0].collisionMask" }),
        expect.objectContaining({ path: "colliders[0].restitution" }),
        expect.objectContaining({ path: "colliders[0].friction" }),
        expect.objectContaining({ path: "colliders[0].density" }),
      ]),
    });
  });

  it("validates canvas limits without treating explicit zero as an omitted default", () => {
    expect(validateCanvasDefinition({
      ...canvas,
      limits: { maxAvatars: 1, maxItems: 0, maxComplexPhysicsItems: 0 },
    })).toEqual({ ok: true });

    expect(validateCanvasDefinition({
      ...canvas,
      limits: { maxAvatars: 0, maxItems: 2.5, maxComplexPhysicsItems: 3 },
    })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "limits.maxAvatars" }),
        expect.objectContaining({ path: "limits.maxItems" }),
        expect.objectContaining({ path: "limits.maxComplexPhysicsItems" }),
      ]),
    });
  });

  it("keeps JSON versions and counters inside their cross-language integer domains", () => {
    expect(validateCanvasDefinition({ ...canvas, version: 0xffff_ffff })).toEqual({ ok: true });
    expect(validateCanvasDefinition({ ...canvas, version: 0x1_0000_0000 })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([expect.objectContaining({ path: "version" })]),
    });
    expect(validateCanvasDefinition({
      ...canvas,
      systemItems: [{
        entityId: "future-item",
        definitionId: "rocket",
        definitionVersion: 0x1_0000_0000,
        transform: { x: 1, y: 1, rotation: 0 },
        resolvedConfig: {},
      }],
    })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "systemItems[0].definitionVersion" }),
      ]),
    });
    expect(validateItemDefinition({
      ...rocketDefinition,
      version: 0x1_0000_0000,
    })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([expect.objectContaining({ path: "version" })]),
    });

    const snapshot = emptySnapshot(canvas.id, canvas.version);
    snapshot.sceneRevision = Number.MAX_SAFE_INTEGER + 1;
    snapshot.items = [{
      entityId: "rocket-1",
      definitionId: "rocket",
      definitionVersion: 0x1_0000_0000,
      ownerUserId: "u1",
      itemRevision: 1,
      transform: { x: 1, y: 1, rotation: 0 },
      resolvedConfig: {},
    }];
    expect(validateSnapshot(snapshot, canvas)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "sceneRevision" }),
        expect.objectContaining({ path: "items[0].definitionVersion" }),
      ]),
    });
  });

  it("refuses NaN and grossly out-of-bounds transforms", () => {
    expect(validateTransform({ x: NaN, y: 0, rotation: 0 }, canvas).ok).toBe(false);
    expect(validateTransform({ x: 100000, y: 0, rotation: 0 }, canvas).ok).toBe(false);
    expect(validateTransform({ x: 50, y: 35, rotation: 1 }, canvas).ok).toBe(true);
    expect(validateTransform({ x: 50, y: 35, rotation: 1, scale: 0 }, canvas).ok)
      .toBe(false);
    expect(validateTransform({ x: canvas.size.width * 4, y: 0, rotation: 0 }, canvas))
      .toEqual({ ok: true });
  });

  it("refuses a snapshot above the item limit", () => {
    const snapshot = emptySnapshot(canvas.id, canvas.version);
    snapshot.items = Array.from({ length: 51 }, (_, i) => ({
      entityId: `item-${i}`,
      definitionId: "rocket",
      definitionVersion: 1,
      ownerUserId: "u1",
      itemRevision: 1,
      transform: { x: 1, y: 1, rotation: 0 },
      resolvedConfig: {},
    }));
    expect(validateSnapshot(snapshot, canvas).ok).toBe(false);
  });

  it("refuses snapshots from an unsupported schema or canvas version", () => {
    expect(validateSnapshot({
      ...emptySnapshot(canvas.id, canvas.version),
      schemaVersion: 2,
    }, canvas)).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ path: "schemaVersion" })],
    });
    expect(validateSnapshot({
      ...emptySnapshot(canvas.id, canvas.version),
      canvasVersion: canvas.version + 1,
    }, canvas)).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ path: "canvasVersion" })],
    });
  });

  it("requires every durable item to carry a positive item revision", () => {
    const snapshot = emptySnapshot(canvas.id, canvas.version);
    snapshot.items = [{
      entityId: "rocket-1",
      definitionId: "rocket",
      definitionVersion: 1,
      ownerUserId: "u1",
      itemRevision: 0,
      transform: { x: 50, y: 35, rotation: 0 },
      resolvedConfig: {},
    }];

    expect(validateSnapshot(snapshot, canvas)).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ path: "items[0].itemRevision" })],
    });
  });

  it("refuses duplicate or out-of-bounds system items", () => {
    const item = {
      entityId: "match-ball",
      definitionId: "ball",
      definitionVersion: 1,
      transform: { x: 101, y: 35, rotation: 0 },
      resolvedConfig: {},
    };
    const result = validateCanvasDefinition({
      ...canvas,
      systemItems: [item, item],
    });
    expect(result).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "systemItems[0].transform" }),
        expect.objectContaining({ path: "systemItems[1].entityId" }),
      ]),
    });
  });

  it("refuses invalid active timer state in a snapshot", () => {
    const snapshot = emptySnapshot(canvas.id, canvas.version);
    snapshot.normalized = false;
    snapshot.items = [{
      entityId: "rocket-1",
      definitionId: "rocket",
      definitionVersion: 1,
      ownerUserId: "u1",
      itemRevision: 1,
      transform: { x: 50, y: 35, rotation: 0 },
      resolvedConfig: {},
      behaviorTimers: [{ key: "countdown", elapsedTicks: 20, remainingTicks: 0 }],
    }];
    expect(validateSnapshot(snapshot, canvas)).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ path: expect.stringContaining("remainingTicks") })],
    });
  });
});

describe("EntityRegistry", () => {
  it("keeps insertion order for reproducible host stepping", () => {
    const registry = new EntityRegistry();
    for (const id of ["c", "a", "b"]) {
      registry.add({ id, kind: "item", transform: { x: 0, y: 0, rotation: 0 } });
    }
    expect(registry.ids()).toEqual(["c", "a", "b"]);
  });

  it("indexes tags and reports removals", () => {
    const registry = new EntityRegistry();
    const removed: string[] = [];
    registry.subscribe((event) => {
      if (event.type === "removed") removed.push(event.entity.id);
    });
    registry.add({
      id: "hill",
      kind: "static",
      transform: { x: 0, y: 0, rotation: 0 },
      tags: new Set(["hill"]),
    });
    expect(registry.taggedWith("hill").map((e) => e.id)).toEqual(["hill"]);
    registry.remove("hill");
    expect(removed).toEqual(["hill"]);
    expect(registry.taggedWith("hill")).toHaveLength(0);
  });

  it("refuses a duplicate entity id", () => {
    const registry = new EntityRegistry();
    registry.add({ id: "a", kind: "item", transform: { x: 0, y: 0, rotation: 0 } });
    expect(() =>
      registry.add({ id: "a", kind: "item", transform: { x: 0, y: 0, rotation: 0 } }),
    ).toThrow(/already exists/);
  });
});

describe("KickableBehavior", () => {
  const build = () =>
    new BehaviorTestHarness<KickableConfig, KickableState>(
      KickableBehavior,
      defaultKickableConfig,
    );

  it("applies an impulse away from a closing avatar", () => {
    const h = build();
    h.host.body(h.entityId).transform = { x: 10, y: 0, rotation: 0 };
    h.host.body("avatar-1").transform = { x: 8, y: 0, rotation: 0 };
    h.host.body("avatar-1").velocity = { x: 6, y: 0 };
    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();
    const impulse = h.commands("applyImpulse")[0] as { impulse: { x: number } };
    expect(impulse.impulse.x).toBeCloseTo(8.4);
    expect(h.state.kickCount).toBe(1);
  });

  it("does not kick when the avatar moves away", () => {
    const h = build();
    h.host.body(h.entityId).transform = { x: 10, y: 0, rotation: 0 };
    h.host.body("avatar-1").transform = { x: 8, y: 0, rotation: 0 };
    h.host.body("avatar-1").velocity = { x: -6, y: 0 };
    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();
    expect(h.commands("applyImpulse")).toHaveLength(0);
  });

  it("caps the impulse and holds a per-avatar cooldown", () => {
    const h = build();
    h.host.body(h.entityId).transform = { x: 10, y: 0, rotation: 0 };
    h.host.body("avatar-1").transform = { x: 8, y: 0, rotation: 0 };
    h.host.body("avatar-1").velocity = { x: 1000, y: 0 };
    const contact = {
      type: "contact.stay" as const,
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
      dwellTicks: 1,
    };
    h.send(contact).flush();
    const first = h.commands("applyImpulse")[0] as { impulse: { x: number } };
    expect(first.impulse.x).toBeCloseTo(defaultKickableConfig.maxImpulse);

    h.send(contact).advance(5);
    expect(h.commands("applyImpulse")).toHaveLength(1);

    h.advance(20);
    h.send(contact).flush();
    expect(h.commands("applyImpulse")).toHaveLength(2);
  });

  it("ignores a contact from another item", () => {
    const h = build();
    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: { entityId: "ball", colliderId: "solid", kind: "item", tags: [] },
    }).flush();
    expect(h.commands("applyImpulse")).toHaveLength(0);
  });
});

describe("PortalBehavior", () => {
  it("teleports the other body and holds a cooldown", () => {
    const h = new BehaviorTestHarness<PortalConfig, PortalState>(PortalBehavior, {
      ...defaultPortalConfig,
      target: { x: 90, y: 10 },
      velocityScale: 0.5,
    });
    h.host.body("avatar-1").transform = { x: 5, y: 5, rotation: 0.5 };
    h.host.body("avatar-1").velocity = { x: 4, y: 0 };
    h.send({
      type: "contact.enter",
      selfColliderId: "portal",
      other: avatarParty("avatar-1"),
    }).flush();
    expect(h.host.body("avatar-1").transform).toMatchObject({ x: 90, y: 10 });
    expect(h.host.body("avatar-1").velocity).toEqual({ x: 2, y: 0 });
    expect(h.state.transitCount).toBe(1);

    h.send({
      type: "contact.enter",
      selfColliderId: "portal",
      other: avatarParty("avatar-1"),
    }).flush();
    expect(h.state.transitCount).toBe(1);
  });

  it("refuses an entity kind it does not accept", () => {
    const h = new BehaviorTestHarness<PortalConfig, PortalState>(PortalBehavior, {
      ...defaultPortalConfig,
      accepts: ["avatar"],
    });
    h.send({
      type: "contact.enter",
      selfColliderId: "portal",
      other: { entityId: "ball", colliderId: "solid", kind: "item", tags: [] },
    }).flush();
    expect(h.state.transitCount).toBe(0);
  });
});

/** Addendum A4. Terrain states which body kinds it stops. */
describe("terrain blocking", () => {
  it("lets an avatar through and stops an item by default", () => {
    const blocking = resolveTerrainBlocking();
    expect(blocking).toEqual({ avatars: false, items: true });
    const mask = terrainMask(blocking);
    expect(mask & CollisionLayer.AVATAR_BODY).toBe(0);
    expect(mask & CollisionLayer.ITEM_SOLID).not.toBe(0);
  });

  it("prefers the collider rule over the canvas rule", () => {
    const blocking = resolveTerrainBlocking({ avatars: true }, { avatars: false, items: false });
    expect(blocking).toEqual({ avatars: true, items: false });
    expect(terrainMask(blocking)).toBe(CollisionLayer.AVATAR_BODY);
  });

  it("stops nothing when both kinds pass through", () => {
    expect(terrainMask(resolveTerrainBlocking({ avatars: false, items: false }))).toBe(0);
  });
});
