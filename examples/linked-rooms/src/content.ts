import type {
  CanvasDefinition,
  KickableConfig,
  ItemDefinition,
  RoomLinkDefinition,
  RoomTravelConfig,
} from "@canvas-physics/core";
import { CollisionLayer } from "@canvas-physics/core";

export const villageToCave = "village-to-cave";
export const caveToVillage = "cave-to-village";
export const villageToPixelRoom = "village-to-pixel-room";
export const pixelRoomToVillage = "pixel-room-to-village";

export const linkedRoomLinks: RoomLinkDefinition[] = [
  {
    id: villageToCave,
    fromRoomId: "linked-village",
    toRoomId: "linked-cave",
    returnLinkId: caveToVillage,
    arrivalSpawnPointId: "from-village",
  },
  {
    id: caveToVillage,
    fromRoomId: "linked-cave",
    toRoomId: "linked-village",
    returnLinkId: villageToCave,
    arrivalSpawnPointId: "from-cave",
  },
  {
    id: villageToPixelRoom,
    fromRoomId: "linked-village",
    toRoomId: "linked-pixel-room",
    returnLinkId: pixelRoomToVillage,
    arrivalSpawnPointId: "from-village",
  },
  {
    id: pixelRoomToVillage,
    fromRoomId: "linked-pixel-room",
    toRoomId: "linked-village",
    returnLinkId: villageToPixelRoom,
    arrivalSpawnPointId: "from-pixel-room",
  },
];

export const roomDoorDefinition: ItemDefinition<RoomTravelConfig> = {
  definitionId: "linked-room-door",
  version: 1,
  displayName: "Linked room door",
  visual: {
    spriteId: "linked.door",
    size: { width: 5, height: 10 },
    anchor: { x: 0.5, y: 0.5 },
    zIndex: 3,
  },
  body: { mode: "fixed", gravityScale: 0, lockRotation: true },
  colliders: [
    {
      id: "threshold",
      role: "itemSensor",
      sensor: true,
      shape: { type: "rect", width: 0.4, height: 5 },
      // The sensor sits behind the visual midpoint. An approaching avatar's
      // leading edge reaches it when the avatar centre reaches the door centre.
      offset: { x: 1.6, y: 0 },
      tags: ["room-exit"],
    },
  ],
  behaviorType: "canvas.roomTravel",
  defaultConfig: { sensorId: "threshold", linkId: "", cooldownSeconds: 1 },
  persistence: { transform: true, behaviorState: true, onRoomSleep: "resetToIdle" },
  complexity: "simple",
};

export const openDoorDefinition: ItemDefinition<RoomTravelConfig> = {
  ...roomDoorDefinition,
  definitionId: "linked-open-door",
  displayName: "Open linked room door",
  visual: {
    spriteId: "linked.openDoor",
    size: { width: 6, height: 9 },
    anchor: { x: 0.5, y: 0.5 },
    zIndex: 3,
  },
};

export const adventureBallDefinition: ItemDefinition<KickableConfig> = {
  definitionId: "linked-adventure-ball",
  version: 1,
  displayName: "Adventure ball",
  visual: {
    spriteId: "linked.adventureBall",
    size: { width: 3.4, height: 3.4 },
    placeholder: { shape: "circle", color: 0xe7473c },
    zIndex: 5,
  },
  body: {
    mode: "dynamic",
    mass: 0.5,
    gravityScale: 0,
    linearDamping: 0.35,
    angularDamping: 0.2,
  },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.55 },
      restitution: 0.82,
      friction: 0.35,
      collisionMask:
        CollisionLayer.WORLD_STATIC |
        CollisionLayer.ITEM_SOLID |
        CollisionLayer.ITEM_SENSOR |
        CollisionLayer.REGION_SENSOR,
    },
    { id: "kick", role: "itemSensor", shape: { type: "circle", radius: 2.15 } },
  ],
  behaviorType: "kickable",
  defaultConfig: {
    sensorId: "kick",
    kickStrength: 3.2,
    minImpulse: 9,
    maxImpulse: 42,
    cooldownSeconds: 0.18,
  },
  persistence: { transform: true, behaviorState: false, onRoomSleep: "resetToIdle" },
  complexity: "simple",
};

const base = {
  version: 1,
  size: { width: 48, height: 30 },
  orientation: "topDown" as const,
  edges: { top: "solid", right: "solid", bottom: "solid", left: "solid" } as const,
  terrainDefaults: { avatars: true, items: true },
  avatarController: { radius: 1.4, maxSpeed: 13, acceleration: 70 },
  staticGeometry: [],
  regions: [],
  environment: {
    base: {
      gravityXY: { x: 0, y: 0 },
      linearDrag: 0.08,
      angularDrag: 0.1,
      softSpeedLimit: 14,
      surfaceFrictionMultiplier: 1,
    },
  },
  limits: { maxAvatars: 12, maxItems: 4, maxComplexPhysicsItems: 0 },
};

export const villageCanvas: CanvasDefinition = {
  ...base,
  id: "linked-village",
  version: 2,
  backgroundAssetId: "linked.village",
  spawnPoints: [
    { id: "village-square", position: { x: 12, y: 15 } },
    { id: "from-cave", position: { x: 36, y: 15 } },
    { id: "from-pixel-room", position: { x: 12, y: 15 } },
  ],
  systemItems: [
    {
      entityId: "village-cave-door",
      definitionId: roomDoorDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 43, y: 15, rotation: 0, scale: 1 },
      resolvedConfig: { sensorId: "threshold", linkId: villageToCave, cooldownSeconds: 1 },
    },
    {
      entityId: "village-pixel-room-door",
      definitionId: openDoorDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 5, y: 15, rotation: Math.PI, scale: 1 },
      resolvedConfig: {
        sensorId: "threshold",
        linkId: villageToPixelRoom,
        cooldownSeconds: 1,
      },
    },
  ],
};

export const caveCanvas: CanvasDefinition = {
  ...base,
  id: "linked-cave",
  backgroundAssetId: "linked.cave",
  spawnPoints: [
    { id: "cave-depths", position: { x: 36, y: 15 } },
    { id: "from-village", position: { x: 12, y: 15 } },
  ],
  systemItems: [
    {
      entityId: "cave-village-door",
      definitionId: roomDoorDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 5, y: 15, rotation: Math.PI, scale: 1 },
      resolvedConfig: { sensorId: "threshold", linkId: caveToVillage, cooldownSeconds: 1 },
    },
  ],
};

export const pixelRoomCanvas: CanvasDefinition = {
  ...base,
  id: "linked-pixel-room",
  backgroundAssetId: "linked.pixelRoom",
  spawnPoints: [
    { id: "room-start", position: { x: 36, y: 15 } },
    { id: "from-village", position: { x: 36, y: 15 } },
  ],
  staticGeometry: [
    {
      id: "top-furniture",
      role: "worldSolid",
      shape: { type: "rect", width: 40, height: 4 },
      position: { x: 24, y: 4 },
    },
    {
      id: "left-bench",
      role: "worldSolid",
      shape: { type: "rect", width: 6, height: 11 },
      position: { x: 5, y: 16 },
    },
    {
      id: "bottom-furniture",
      role: "worldSolid",
      shape: { type: "rect", width: 31, height: 3 },
      position: { x: 29, y: 27.5 },
    },
  ],
  systemItems: [
    {
      entityId: "pixel-room-village-door",
      definitionId: openDoorDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 43, y: 15, rotation: 0, scale: 1 },
      resolvedConfig: {
        sensorId: "threshold",
        linkId: pixelRoomToVillage,
        cooldownSeconds: 1,
      },
    },
    {
      entityId: "pixel-room-ball",
      definitionId: adventureBallDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 24, y: 15, rotation: 0, scale: 1 },
      resolvedConfig: adventureBallDefinition.defaultConfig,
    },
  ],
};

export const linkedRoomDefinitions: ItemDefinition[] = [
  roomDoorDefinition,
  openDoorDefinition,
  adventureBallDefinition,
];
