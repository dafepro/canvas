import {
  defaultKickableConfig,
  defaultRocketConfig,
  type CanvasDefinition,
  type ItemDefinition,
} from "@canvas-physics/core";

/** Spec 18. The reference canvas: side view, hill, launch pad, space gradient. */
export const rocketCanvas: CanvasDefinition = {
  id: "rocket-canvas",
  version: 1,
  size: { width: 100, height: 70 },
  orientation: "side",
  edges: { top: "wrap", right: "solid", bottom: "solid", left: "solid" },
  staticGeometry: [
    {
      id: "ground",
      shape: { type: "rect", width: 100, height: 4 },
      position: { x: 50, y: 68 },
      tags: ["ground", "floor"],
      friction: 0.9,
    },
    {
      id: "hill",
      shape: {
        type: "polygon",
        vertices: [
          { x: -14, y: 6 },
          { x: 14, y: 6 },
          { x: 0, y: -8 },
        ],
      },
      position: { x: 22, y: 60 },
      tags: ["ground", "hill"],
      friction: 0.7,
    },
    {
      id: "launch-pad",
      shape: { type: "rect", width: 12, height: 1.5 },
      position: { x: 70, y: 65.5 },
      tags: ["ground", "launchPad"],
      friction: 1,
    },
    {
      id: "pad-zone",
      shape: { type: "rect", width: 12, height: 6 },
      position: { x: 70, y: 61 },
      role: "regionSensor",
      tags: ["launchPadZone"],
    },
  ],
  regions: [
    {
      id: "space",
      shape: { type: "rect", x: 0, y: 0, w: 100, h: 40 },
      tags: ["space"],
      emitEvents: true,
    },
  ],
  environment: {
    base: { gravityXY: { x: 0, y: 20 }, linearDrag: 0.1, angularDrag: 0.2 },
    regions: [
      {
        id: "space-gradient",
        shape: { type: "rect", x: 0, y: 0, w: 100, h: 40 },
        blend: "linear",
        axis: "y",
        from: 40,
        to: 10,
        priority: 0,
        gravityScale: [1.0, 0.1],
        linearDrag: [0.1, 0.45],
        softSpeedLimit: [null, 12],
      },
    ],
  },
  spawnPoints: [
    { id: "centre", position: { x: 50, y: 62 } },
    { id: "pad", position: { x: 70, y: 62 } },
  ],
  limits: { maxAvatars: 20, maxItems: 50, maxComplexPhysicsItems: 5 },
};

/** The rocket. Its physics values come from the canvas, not from the behavior. */
export const rocketDefinition: ItemDefinition<typeof defaultRocketConfig> = {
  definitionId: "rocket",
  version: 1,
  displayName: "Rocket",
  visual: {
    size: { width: 3, height: 6 },
    placeholder: { shape: "triangle", color: 0xf1faee },
    zIndex: 5,
    variants: {
      idle: { color: 0xf1faee },
      arming: { color: 0xffd166 },
      flying: { color: 0xff8c42 },
      spaceDrift: { color: 0xa7e8ff },
      falling: { color: 0xff6b6b },
      landed: { color: 0x9bf6a0 },
    },
  },
  body: {
    mode: "dynamic",
    mass: 2,
    gravityScale: 1,
    linearDamping: 0,
    angularDamping: 0.6,
  },
  colliders: [
    { id: "hull", role: "itemSolid", shape: { type: "capsule", halfHeight: 2, radius: 1 }, friction: 0.5, restitution: 0.1 },
    { id: "arm", role: "itemSensor", shape: { type: "circle", radius: 3.4 } },
    { id: "pad", role: "itemSensor", shape: { type: "circle", radius: 1.2 }, offset: { x: 0, y: 3 } },
  ],
  behaviorType: "rocket",
  defaultConfig: defaultRocketConfig,
  tuningRules: [
    {
      when: { maxCanvasWidth: 70 },
      overrides: { thrust: 18, launchImpulse: 9, maxSpeed: 14 },
    },
    {
      when: { minCanvasWidth: 70 },
      overrides: { thrust: 24, launchImpulse: 12, maxSpeed: 19 },
    },
  ],
  persistence: { transform: true, behaviorState: true, onRoomSleep: "resetToIdle" },
  complexity: "complex",
};

/** A ball an avatar can pass through while still kicking it (spec 5.4). */
export const ballDefinition: ItemDefinition<typeof defaultKickableConfig> = {
  definitionId: "ball",
  version: 1,
  displayName: "Ball",
  visual: {
    size: { width: 2.4, height: 2.4 },
    placeholder: { shape: "circle", color: 0xffd166 },
    zIndex: 4,
  },
  body: { mode: "dynamic", mass: 0.6, gravityScale: 1, angularDamping: 0.4 },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.2 },
      restitution: 0.75,
      friction: 0.4,
      // The avatar body passes through; only the world and other items collide.
      collisionMask: 0b0000_1100,
    },
    { id: "kick", role: "itemSensor", shape: { type: "circle", radius: 1.9 } },
  ],
  behaviorType: "kickable",
  defaultConfig: defaultKickableConfig,
  persistence: { transform: true, behaviorState: false, onRoomSleep: "resetToIdle" },
  complexity: "simple",
};

/** A crate that collides with everything, for a plain physics comparison. */
export const crateDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "crate",
  version: 1,
  displayName: "Crate",
  visual: {
    size: { width: 3, height: 3 },
    placeholder: { shape: "rect", color: 0xb08968 },
    zIndex: 3,
  },
  body: { mode: "dynamic", mass: 1.5, gravityScale: 1 },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "rect", width: 3, height: 3 },
      friction: 0.8,
      restitution: 0.05,
    },
  ],
  persistence: { transform: true, behaviorState: false, onRoomSleep: "resetToIdle" },
  complexity: "simple",
};

export const rocketCanvasDefinitions: ItemDefinition[] = [
  rocketDefinition as ItemDefinition,
  ballDefinition as ItemDefinition,
  crateDefinition as ItemDefinition,
];
