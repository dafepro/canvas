import { CollisionLayer, type ItemDefinition } from "@canvas-physics/core";
import {
  defaultReactiveOrbConfig,
  type ReactiveOrbConfig,
} from "./reactive-orb-behavior.js";
import {
  defaultLiveBouncerConfig,
  type LiveBouncerConfig,
} from "./live-bouncer-behavior.js";
import {
  defaultPairedPortalConfig,
  type PairedPortalConfig,
} from "./paired-portal-behavior.js";
import {
  antigravityFieldConfig,
  blackHoleFieldConfig,
  type ForceFieldConfig,
} from "./force-field-behavior.js";
import {
  defaultGraffitiConfig,
  type GraffitiConfig,
} from "./graffiti-behavior.js";

const durableFixed = {
  body: { mode: "fixed" as const, gravityScale: 0, lockRotation: true },
  persistence: {
    transform: true,
    behaviorState: false,
    onRoomSleep: "pause" as const,
  },
  complexity: "simple" as const,
};

export const partyEmojiDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "emoji-party",
  version: 1,
  displayName: "Party emoji",
  visual: {
    spriteId: "playground.emoji.party",
    size: { width: 5, height: 5 },
    placeholder: { shape: "circle", color: 0xffd84d },
    zIndex: 5,
  },
  ...durableFixed,
  colliders: [
    { id: "solid", role: "itemSolid", shape: { type: "circle", radius: 2.25 } },
  ],
  defaultConfig: {},
};

export const photoCardDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "photo-card",
  version: 1,
  displayName: "Picture card",
  visual: {
    spriteId: "playground.photo",
    size: { width: 6, height: 5 },
    placeholder: { shape: "rect", color: 0x9dd8ff },
    zIndex: 4,
  },
  ...durableFixed,
  colliders: [
    { id: "solid", role: "itemSolid", shape: { type: "rect", width: 6, height: 5 } },
  ],
  defaultConfig: {},
};

export const reactiveOrbDefinition: ItemDefinition<ReactiveOrbConfig> = {
  definitionId: "reactive-orb",
  version: 2,
  displayName: "Reactive orb",
  visual: {
    spriteId: "playground.orb.mint",
    size: { width: 5, height: 5 },
    placeholder: { shape: "circle", color: 0x68e0c2 },
    zIndex: 6,
    variants: {
      mint: { spriteId: "playground.orb.mint" },
      coral: { spriteId: "playground.orb.coral" },
      violet: { spriteId: "playground.orb.violet" },
      custom: { spriteId: "playground.orb.custom" },
    },
    animations: {
      pulse: {
        frames: [
          "playground.orb.mint",
          "playground.orb.pulse",
          "playground.orb.violet",
          "playground.orb.mint",
        ],
        fps: 12,
        loop: false,
      },
    },
  },
  body: { mode: "fixed", gravityScale: 0 },
  colliders: [
    { id: "solid", role: "itemSolid", shape: { type: "circle", radius: 2.1 } },
    {
      id: "touch",
      role: "itemSensor",
      shape: { type: "circle", radius: 2.7 },
    },
  ],
  behaviorType: "reactiveOrb",
  defaultConfig: defaultReactiveOrbConfig,
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const systemStampDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "system-stamp",
  version: 1,
  displayName: "Room-owned stamp",
  visual: {
    spriteId: "playground.system.stamp",
    size: { width: 6, height: 3.5 },
    placeholder: { shape: "rect", color: 0x18253a },
    zIndex: 3,
  },
  ...durableFixed,
  colliders: [],
  defaultConfig: {},
};

export const colorTileDefinition: ItemDefinition<ReactiveOrbConfig> = {
  definitionId: "color-tile",
  version: 2,
  displayName: "Color tile",
  visual: {
    spriteId: "playground.tile.mint",
    size: { width: 6, height: 4.5 },
    placeholder: { shape: "rect", color: 0x68e0c2 },
    zIndex: 5,
    variants: {
      mint: { spriteId: "playground.tile.mint" },
      coral: { spriteId: "playground.tile.coral" },
      violet: { spriteId: "playground.tile.violet" },
      custom: { spriteId: "playground.tile.custom" },
    },
  },
  ...durableFixed,
  behaviorType: "reactiveOrb",
  colliders: [
    { id: "solid", role: "itemSolid", shape: { type: "rect", width: 6, height: 4.5 } },
  ],
  defaultConfig: defaultReactiveOrbConfig,
};

export const liveBouncerDefinition: ItemDefinition<LiveBouncerConfig> = {
  definitionId: "live-bouncer",
  version: 4,
  displayName: "Always-live ball",
  visual: {
    spriteId: "playground.ball",
    size: { width: 3.6, height: 3.6 },
    placeholder: { shape: "circle", color: 0xf7d74b },
    zIndex: 8,
  },
  body: {
    mode: "dynamic",
    gravityScale: 0,
    linearDamping: 0.22,
    angularDamping: 0.05,
    canSleep: false,
  },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.75 },
      collisionMask:
        CollisionLayer.WORLD_STATIC |
        CollisionLayer.ITEM_SOLID |
        CollisionLayer.AVATAR_BODY |
        CollisionLayer.AVATAR_SENSOR |
        CollisionLayer.ITEM_SENSOR |
        CollisionLayer.REGION_SENSOR |
        CollisionLayer.PORTAL_SENSOR,
      restitution: 1,
      friction: 0,
    },
  ],
  behaviorType: "liveBouncer",
  defaultConfig: defaultLiveBouncerConfig,
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const playgroundAvatarDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "avatar",
  version: 1,
  displayName: "Playground visitor",
  visual: {
    spriteId: "playground.avatar.maker",
    size: { width: 2.6, height: 2.6 },
    placeholder: { shape: "circle", color: 0xffffff },
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

export const pairedPortalDefinition: ItemDefinition<PairedPortalConfig> = {
  definitionId: "paired-portal",
  version: 1,
  displayName: "Linked portal pair",
  visual: {
    spriteId: "playground.portal.pair",
    size: { width: 13.5, height: 5 },
    placeholder: { shape: "rect", color: 0x7356d8 },
    zIndex: 7,
    animations: {
      surge: {
        frames: [
          "playground.portal.pair",
          "playground.portal.pairPulse",
          "playground.portal.pair",
        ],
        fps: 9,
        loop: false,
      },
    },
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [
    {
      id: "left-portal",
      role: "portalSensor",
      shape: { type: "circle", radius: 1.8 },
      offset: { x: -4.3, y: 0 },
    },
    {
      id: "right-portal",
      role: "portalSensor",
      shape: { type: "circle", radius: 1.8 },
      offset: { x: 4.3, y: 0 },
    },
  ],
  behaviorType: "playground.pairedPortal",
  defaultConfig: defaultPairedPortalConfig,
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const antigravityFieldDefinition: ItemDefinition<ForceFieldConfig> = {
  definitionId: "antigravity-field",
  version: 1,
  displayName: "Antigravity field",
  visual: {
    spriteId: "playground.field.antigravity",
    size: { width: 8, height: 10 },
    placeholder: { shape: "rect", color: 0x76ead6 },
    zIndex: 2,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [
    {
      id: "field",
      role: "itemSensor",
      shape: { type: "rect", width: 8, height: 10 },
    },
  ],
  behaviorType: "playground.forceField",
  defaultConfig: antigravityFieldConfig,
  persistence: { transform: true, behaviorState: true, onRoomSleep: "pause" },
  complexity: "simple",
};

export const blackHoleDefinition: ItemDefinition<ForceFieldConfig> = {
  definitionId: "black-hole",
  version: 1,
  displayName: "Black hole",
  visual: {
    spriteId: "playground.field.blackHole",
    size: { width: 12, height: 12 },
    placeholder: { shape: "circle", color: 0x171327 },
    zIndex: 2,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [
    {
      id: "field",
      role: "itemSensor",
      shape: { type: "circle", radius: 7 },
    },
  ],
  behaviorType: "playground.forceField",
  defaultConfig: blackHoleFieldConfig,
  persistence: { transform: true, behaviorState: true, onRoomSleep: "pause" },
  complexity: "simple",
};

export const graffitiDefinition: ItemDefinition<GraffitiConfig> = {
  definitionId: "graffiti-text",
  version: 1,
  displayName: "Custom graffiti",
  visual: {
    spriteId: "playground.graffiti.anchor",
    size: { width: 11, height: 6.5 },
    placeholder: { shape: "rect", color: 0x71829b },
    zIndex: 4,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [],
  behaviorType: "playground.graffiti",
  defaultConfig: defaultGraffitiConfig,
  persistence: { transform: true, behaviorState: true, onRoomSleep: "pause" },
  complexity: "simple",
};

export const playgroundDefinitions: ItemDefinition[] = [
  partyEmojiDefinition,
  photoCardDefinition,
  reactiveOrbDefinition as ItemDefinition,
  colorTileDefinition as ItemDefinition,
  liveBouncerDefinition as ItemDefinition,
  systemStampDefinition,
  pairedPortalDefinition as ItemDefinition,
  antigravityFieldDefinition as ItemDefinition,
  blackHoleDefinition as ItemDefinition,
  graffitiDefinition as ItemDefinition,
  playgroundAvatarDefinition,
];
