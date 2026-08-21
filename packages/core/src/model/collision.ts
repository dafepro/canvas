/**
 * Collision roles from spec section 5.3. An entity may carry several colliders,
 * each with its own role, membership bit, and filter mask.
 */
export const CollisionLayer = {
  AVATAR_BODY: 1 << 0,
  AVATAR_SENSOR: 1 << 1,
  WORLD_STATIC: 1 << 2,
  ITEM_SOLID: 1 << 3,
  ITEM_SENSOR: 1 << 4,
  REGION_SENSOR: 1 << 5,
  PORTAL_SENSOR: 1 << 6,
} as const;

export type CollisionLayerName = keyof typeof CollisionLayer;

export type ColliderRole =
  | "avatarBody"
  | "avatarSensor"
  | "worldStatic"
  | "itemSolid"
  | "itemSensor"
  | "regionSensor"
  | "portalSensor"
  | "decorative";

/** Default membership bit for each role. */
export const roleMembership: Record<ColliderRole, number> = {
  avatarBody: CollisionLayer.AVATAR_BODY,
  avatarSensor: CollisionLayer.AVATAR_SENSOR,
  worldStatic: CollisionLayer.WORLD_STATIC,
  itemSolid: CollisionLayer.ITEM_SOLID,
  itemSensor: CollisionLayer.ITEM_SENSOR,
  regionSensor: CollisionLayer.REGION_SENSOR,
  portalSensor: CollisionLayer.PORTAL_SENSOR,
  decorative: 0,
};

/**
 * Default filter mask for each role. An avatar body does not collide with
 * another avatar body, so avatars pass through each other (spec 2.1).
 */
export const roleDefaultMask: Record<ColliderRole, number> = {
  avatarBody:
    CollisionLayer.WORLD_STATIC | CollisionLayer.ITEM_SOLID,
  avatarSensor:
    CollisionLayer.ITEM_SENSOR |
    CollisionLayer.ITEM_SOLID |
    CollisionLayer.REGION_SENSOR |
    CollisionLayer.PORTAL_SENSOR,
  worldStatic:
    CollisionLayer.AVATAR_BODY | CollisionLayer.ITEM_SOLID,
  itemSolid:
    CollisionLayer.WORLD_STATIC |
    CollisionLayer.ITEM_SOLID |
    CollisionLayer.AVATAR_BODY |
    CollisionLayer.AVATAR_SENSOR,
  itemSensor: CollisionLayer.AVATAR_SENSOR | CollisionLayer.ITEM_SOLID,
  regionSensor:
    CollisionLayer.AVATAR_SENSOR | CollisionLayer.ITEM_SOLID,
  portalSensor:
    CollisionLayer.AVATAR_SENSOR | CollisionLayer.ITEM_SOLID,
  decorative: 0,
};

export const isSensorRole = (role: ColliderRole): boolean =>
  role === "avatarSensor" ||
  role === "itemSensor" ||
  role === "regionSensor" ||
  role === "portalSensor";
