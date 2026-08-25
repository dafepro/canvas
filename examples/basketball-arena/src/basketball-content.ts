import {
  CollisionLayer,
  type CanvasDefinition,
  type ItemDefinition,
} from "@canvas-physics/core";
import {
  defaultBasketballConfig,
  type BasketballConfig,
} from "./basketball-behavior.js";

export const basketballBallDefinition: ItemDefinition<BasketballConfig> = {
  definitionId: "basketball-game-ball",
  version: 1,
  displayName: "Game ball",
  visual: {
    spriteId: "basketball.ball",
    size: { width: 3.2, height: 3.2 },
    placeholder: { shape: "circle", color: 0xf97316 },
    zIndex: 8,
    variants: {
      scored: { color: 0xffd166 },
    },
  },
  body: {
    mode: "dynamic",
    mass: 0.55,
    gravityScale: 0,
    linearDamping: 0.22,
    angularDamping: 0.28,
    canSleep: true,
  },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.5 },
      restitution: 0.86,
      friction: 0.25,
      collisionMask:
        CollisionLayer.WORLD_STATIC |
        CollisionLayer.ITEM_SOLID |
        CollisionLayer.AVATAR_BODY |
        CollisionLayer.AVATAR_SENSOR |
        CollisionLayer.ITEM_SENSOR |
        CollisionLayer.REGION_SENSOR,
    },
    {
      id: "kick",
      role: "itemSensor",
      shape: { type: "circle", radius: 2.3 },
    },
  ],
  behaviorType: "basketballGameBall",
  defaultConfig: defaultBasketballConfig,
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const basketballHoopDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "basketball-hoop",
  version: 1,
  displayName: "Basket and backboard",
  visual: {
    spriteId: "basketball.hoop",
    size: { width: 14, height: 9.3 },
    anchor: { x: 0.5, y: 0.5 },
    zIndex: 4,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [],
  defaultConfig: {},
  persistence: {
    transform: true,
    behaviorState: false,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const basketballMirroredHoopDefinition: ItemDefinition<Record<string, never>> = {
  ...basketballHoopDefinition,
  definitionId: "basketball-hoop-mirrored",
  displayName: "Mirrored basket and backboard",
  visual: { ...basketballHoopDefinition.visual, mirrorX: true },
};

const scoreboardDefinition = (
  team: "teal" | "coral",
): ItemDefinition<Record<string, never>> => ({
  definitionId: `basketball-scoreboard-${team}`,
  version: 1,
  displayName: `${team === "teal" ? "Teal" : "Coral"} scoreboard`,
  visual: {
    spriteId: `basketball.scoreboard.${team}`,
    size: { width: 9, height: 6 },
    anchor: { x: 0.5, y: 0.5 },
    zIndex: 5,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [],
  defaultConfig: {},
  persistence: {
    transform: true,
    behaviorState: false,
    onRoomSleep: "pause",
  },
  complexity: "simple",
});

export const basketballTealScoreboardDefinition = scoreboardDefinition("teal");
export const basketballCoralScoreboardDefinition = scoreboardDefinition("coral");

export const basketballAvatarDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "avatar",
  version: 1,
  displayName: "Basketball player",
  visual: {
    spriteId: "basketball.avatar",
    size: { width: 5.2, height: 7.8 },
    anchor: { x: 0.5, y: 0.56 },
    placeholder: { shape: "circle", color: 0x16b8b0 },
    zIndex: 10,
  },
  colliders: [],
  defaultConfig: {},
  persistence: {
    transform: false,
    behaviorState: false,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const basketballDefinitions: ItemDefinition[] = [
  basketballBallDefinition as ItemDefinition,
  basketballHoopDefinition as ItemDefinition,
  basketballMirroredHoopDefinition as ItemDefinition,
  basketballTealScoreboardDefinition as ItemDefinition,
  basketballCoralScoreboardDefinition as ItemDefinition,
  basketballAvatarDefinition as ItemDefinition,
];

export const basketballCanvas: CanvasDefinition = {
  id: "basketball-arena-v2",
  version: 2,
  size: { width: 70, height: 42 },
  orientation: "topDown",
  backgroundAssetId: "basketball.court",
  edges: { top: "solid", right: "solid", bottom: "solid", left: "solid" },
  terrainDefaults: { avatars: true, items: true },
  avatarController: {
    radius: 1.35,
    maxSpeed: 19,
    acceleration: 115,
    flickDeceleration: 14,
    maxTurnSpeed: 7,
  },
  staticGeometry: [
    {
      id: "left-backboard",
      shape: { type: "rect", width: 0.55, height: 8 },
      position: { x: 6.35, y: 21 },
      tags: ["basketFrame", "leftBasket"],
      restitution: 0.74,
      friction: 0.35,
    },
    {
      id: "right-backboard",
      shape: { type: "rect", width: 0.55, height: 8 },
      position: { x: 63.65, y: 21 },
      tags: ["basketFrame", "rightBasket"],
      restitution: 0.74,
      friction: 0.35,
    },
    ...[18.9, 23.1].flatMap((y) => [
      {
        id: `left-rim-${y}`,
        shape: { type: "circle" as const, radius: 0.28 },
        position: { x: 7.8, y },
        tags: ["rim", "leftBasket"],
        restitution: 0.9,
      },
      {
        id: `right-rim-${y}`,
        shape: { type: "circle" as const, radius: 0.28 },
        position: { x: 62.2, y },
        tags: ["rim", "rightBasket"],
        restitution: 0.9,
      },
    ]),
  ],
  regions: [
    {
      id: "left-basket-score",
      shape: { type: "circle", x: 7.8, y: 21, radius: 1.45 },
      tags: ["basket", "coralScores"],
      emitEvents: true,
    },
    {
      id: "right-basket-score",
      shape: { type: "circle", x: 62.2, y: 21, radius: 1.45 },
      tags: ["basket", "tealScores"],
      emitEvents: true,
    },
  ],
  environment: {
    base: {
      gravityXY: { x: 0, y: 0 },
      linearDrag: 0.12,
      angularDrag: 0.2,
      softSpeedLimit: 30,
      surfaceFrictionMultiplier: 1,
    },
    regions: [
      {
        id: "left-net-damping",
        shape: { type: "circle", x: 7.1, y: 21, radius: 2.2 },
        blend: "radial",
        priority: 10,
        linearDrag: [2.4, 0.5],
        angularDrag: [3, 0.4],
        softSpeedLimit: [7, 16],
      },
      {
        id: "right-net-damping",
        shape: { type: "circle", x: 62.9, y: 21, radius: 2.2 },
        blend: "radial",
        priority: 10,
        linearDrag: [2.4, 0.5],
        angularDrag: [3, 0.4],
        softSpeedLimit: [7, 16],
      },
    ],
  },
  spawnPoints: [
    { id: "teal", position: { x: 25, y: 21 } },
    { id: "coral", position: { x: 45, y: 21 } },
    { id: "sideline", position: { x: 35, y: 37 } },
  ],
  systemItems: [
    {
      entityId: "basketball-game-ball",
      definitionId: basketballBallDefinition.definitionId,
      definitionVersion: basketballBallDefinition.version,
      transform: { x: 35, y: 21, rotation: 0, scale: 1 },
      resolvedConfig: defaultBasketballConfig,
    },
    {
      entityId: "left-basketball-hoop",
      definitionId: basketballHoopDefinition.definitionId,
      definitionVersion: basketballHoopDefinition.version,
      transform: { x: 4, y: 21, rotation: 0, scale: 1 },
      resolvedConfig: {},
    },
    {
      entityId: "right-basketball-hoop",
      definitionId: basketballMirroredHoopDefinition.definitionId,
      definitionVersion: basketballMirroredHoopDefinition.version,
      transform: { x: 66, y: 21, rotation: 0, scale: 1 },
      resolvedConfig: {},
    },
    {
      entityId: "teal-scoreboard",
      definitionId: basketballTealScoreboardDefinition.definitionId,
      definitionVersion: basketballTealScoreboardDefinition.version,
      transform: { x: 11, y: 7, rotation: 0, scale: 1 },
      resolvedConfig: {},
    },
    {
      entityId: "coral-scoreboard",
      definitionId: basketballCoralScoreboardDefinition.definitionId,
      definitionVersion: basketballCoralScoreboardDefinition.version,
      transform: { x: 59, y: 7, rotation: 0, scale: 1 },
      resolvedConfig: {},
    },
  ],
  limits: { maxAvatars: 16, maxItems: 5, maxComplexPhysicsItems: 0 },
};
