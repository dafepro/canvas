import type {
  CanvasDefinition,
  ItemDefinition,
  RoomLinkDefinition,
  RoomTravelConfig,
} from "@canvas-physics/core";

export const villageToCave = "village-to-cave";
export const caveToVillage = "cave-to-village";

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
  backgroundAssetId: "linked.village",
  spawnPoints: [
    { id: "village-square", position: { x: 12, y: 15 } },
    { id: "from-cave", position: { x: 36, y: 15 } },
  ],
  systemItems: [
    {
      entityId: "village-cave-door",
      definitionId: roomDoorDefinition.definitionId,
      definitionVersion: 1,
      transform: { x: 43, y: 15, rotation: 0, scale: 1 },
      resolvedConfig: { sensorId: "threshold", linkId: villageToCave, cooldownSeconds: 1 },
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

export const linkedRoomDefinitions: ItemDefinition[] = [roomDoorDefinition];
