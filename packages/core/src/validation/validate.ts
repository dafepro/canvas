import type {
  CanvasDefinition,
  FieldValue,
  RegionFieldModifier,
} from "../model/canvas-definition.js";
import type { ItemDefinition } from "../model/item-definition.js";
import type { Transform } from "../model/item-instance.js";
import type { RegionShape, ShapeDefinition } from "../model/shapes.js";
import type { CanvasSnapshot } from "../model/snapshot.js";
import { SCHEMA_VERSIONS } from "../model/versioning.js";

export interface Problem {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; problems: Problem[] };

const result = (problems: Problem[]): ValidationResult =>
  problems.length === 0 ? { ok: true } : { ok: false, problems };

const MAX_UINT32 = 0xffff_ffff;
const isUint32 = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= MAX_UINT32;
const isPositiveUint32 = (value: number): boolean => isUint32(value) && value > 0;
const isNonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const isFiniteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isFinitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const isCollisionBits = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 0xffff;

const validateShape = (
  shape: ShapeDefinition,
  path: string,
  problems: Problem[],
): void => {
  switch (shape.type) {
    case "circle":
      if (!isFinitePositive(shape.radius)) {
        problems.push({ path: `${path}.radius`, message: "must be a positive finite number" });
      }
      break;
    case "rect":
      if (!isFinitePositive(shape.width)) {
        problems.push({ path: `${path}.width`, message: "must be a positive finite number" });
      }
      if (!isFinitePositive(shape.height)) {
        problems.push({ path: `${path}.height`, message: "must be a positive finite number" });
      }
      break;
    case "capsule":
      if (!isFiniteNonNegative(shape.halfHeight)) {
        problems.push({
          path: `${path}.halfHeight`,
          message: "must be a non-negative finite number",
        });
      }
      if (!isFinitePositive(shape.radius)) {
        problems.push({ path: `${path}.radius`, message: "must be a positive finite number" });
      }
      break;
    case "polygon":
      if (shape.vertices.length < 3) {
        problems.push({ path: `${path}.vertices`, message: "must contain at least three vertices" });
      }
      shape.vertices.forEach((vertex, index) => {
        if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
          problems.push({
            path: `${path}.vertices[${index}]`,
            message: "coordinates must be finite",
          });
        }
      });
      break;
  }
};

const finiteVec2 = (value: { x: number; y: number }): boolean =>
  Number.isFinite(value.x) && Number.isFinite(value.y);

const validateRegionShape = (
  shape: RegionShape,
  path: string,
  problems: Problem[],
): void => {
  if (!Number.isFinite(shape.x) || !Number.isFinite(shape.y)) {
    problems.push({ path, message: "position must be finite" });
  }
  if (shape.type === "circle") {
    if (!isFinitePositive(shape.radius)) {
      problems.push({ path: `${path}.radius`, message: "must be a positive finite number" });
    }
    return;
  }
  if (!isFinitePositive(shape.w)) {
    problems.push({ path: `${path}.w`, message: "must be a positive finite number" });
  }
  if (!isFinitePositive(shape.h)) {
    problems.push({ path: `${path}.h`, message: "must be a positive finite number" });
  }
};

const finiteFieldValue = <T extends number | { x: number; y: number } | null>(
  value: FieldValue<T>,
  allowNull: boolean,
): boolean => {
  const samples = Array.isArray(value) ? value : [value];
  return samples.every((sample) => {
    if (sample === null) return allowNull;
    if (typeof sample === "number") return Number.isFinite(sample);
    return finiteVec2(sample);
  });
};

const nonNegativeFieldValue = (value: FieldValue<number | null>): boolean => {
  const samples = Array.isArray(value) ? value : [value];
  return samples.every((sample) => sample === null || isFiniteNonNegative(sample));
};

const validateFieldModifier = (
  modifier: RegionFieldModifier,
  path: string,
  problems: Problem[],
): void => {
  if (!Number.isFinite(modifier.priority)) {
    problems.push({ path: `${path}.priority`, message: "must be finite" });
  }
  for (const key of ["from", "to"] as const) {
    const value = modifier[key];
    if (value !== undefined && !Number.isFinite(value)) {
      problems.push({ path: `${path}.${key}`, message: "must be finite" });
    }
  }
  for (const key of ["gravityScale", "gravityXY", "zGravity"] as const) {
    const value = modifier[key];
    if (value !== undefined && !finiteFieldValue(value, false)) {
      problems.push({ path: `${path}.${key}`, message: "must contain finite values" });
    }
  }
  for (const key of [
    "linearDrag",
    "angularDrag",
    "softSpeedLimit",
    "surfaceFrictionMultiplier",
    "zDrag",
  ] as const) {
    const value = modifier[key];
    if (value !== undefined && !nonNegativeFieldValue(value)) {
      problems.push({
        path: `${path}.${key}`,
        message: "must contain non-negative finite values or null",
      });
    }
  }
};

export const validateCanvasDefinition = (
  canvas: CanvasDefinition,
): ValidationResult => {
  const problems: Problem[] = [];
  if (!canvas.id) problems.push({ path: "id", message: "required" });
  if (!isPositiveUint32(canvas.version)) {
    problems.push({ path: "version", message: "must be a positive uint32 integer" });
  }
  if (
    !Number.isFinite(canvas.size.width) || canvas.size.width <= 0 ||
    !Number.isFinite(canvas.size.height) || canvas.size.height <= 0
  ) {
    problems.push({ path: "size", message: "width and height must be positive finite numbers" });
  }
  if (canvas.orientation !== "topDown" && canvas.orientation !== "side") {
    problems.push({ path: "orientation", message: 'must be "topDown" or "side"' });
  }
  const edgePolicies = new Set(["solid", "wrap", "respawn", "open"]);
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    if (!edgePolicies.has(canvas.edges[edge])) {
      problems.push({ path: `edges.${edge}`, message: "unknown edge policy" });
    }
  }
  if (!Number.isSafeInteger(canvas.limits.maxAvatars) || canvas.limits.maxAvatars < 1) {
    problems.push({ path: "limits.maxAvatars", message: "must be a positive safe integer" });
  }
  if (!Number.isSafeInteger(canvas.limits.maxItems) || canvas.limits.maxItems < 0) {
    problems.push({ path: "limits.maxItems", message: "must be a non-negative safe integer" });
  }
  if (
    !Number.isSafeInteger(canvas.limits.maxComplexPhysicsItems) ||
    canvas.limits.maxComplexPhysicsItems < 0 ||
    canvas.limits.maxComplexPhysicsItems > canvas.limits.maxItems
  ) {
    problems.push({
      path: "limits.maxComplexPhysicsItems",
      message: "must be a non-negative safe integer no greater than maxItems",
    });
  }
  for (const key of [
    "radius",
    "maxSpeed",
    "acceleration",
    "flickDeceleration",
    "maxTurnSpeed",
    "directInteractionMaxSpeed",
  ] as const) {
    const value = canvas.avatarController?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      problems.push({
        path: `avatarController.${key}`,
        message: "must be a positive finite number",
      });
    }
  }
  const facing = canvas.avatarController?.facing;
  if (facing !== undefined && facing !== "movement" && facing !== "fixed") {
    problems.push({
      path: "avatarController.facing",
      message: 'must be "movement" or "fixed"',
    });
  }
  const spawnIds = new Set<string>();
  canvas.spawnPoints.forEach((spawn, i) => {
    const path = `spawnPoints[${i}]`;
    if (!spawn.id) problems.push({ path: `${path}.id`, message: "required" });
    if (spawnIds.has(spawn.id)) {
      problems.push({ path: `${path}.id`, message: `duplicate id ${spawn.id}` });
    }
    spawnIds.add(spawn.id);
    if (
      !finiteVec2(spawn.position) || spawn.position.x < 0 ||
      spawn.position.x > canvas.size.width || spawn.position.y < 0 ||
      spawn.position.y > canvas.size.height
    ) {
      problems.push({ path: `${path}.position`, message: "must be finite and inside canvas" });
    }
    if (spawn.rotation !== undefined && !Number.isFinite(spawn.rotation)) {
      problems.push({ path: `${path}.rotation`, message: "must be finite" });
    }
  });
  const staticIds = new Set<string>();
  canvas.staticGeometry.forEach((collider, i) => {
    const path = `staticGeometry[${i}]`;
    if (!collider.id) problems.push({ path: `${path}.id`, message: "required" });
    if (staticIds.has(collider.id)) {
      problems.push({ path: `${path}.id`, message: `duplicate id ${collider.id}` });
    }
    staticIds.add(collider.id);
    validateShape(collider.shape, `${path}.shape`, problems);
    if (!finiteVec2(collider.position)) {
      problems.push({ path: `${path}.position`, message: "coordinates must be finite" });
    }
    if (collider.rotation !== undefined && !Number.isFinite(collider.rotation)) {
      problems.push({ path: `${path}.rotation`, message: "must be finite" });
    }
    if (
      collider.restitution !== undefined &&
      (!Number.isFinite(collider.restitution) || collider.restitution < 0 ||
        collider.restitution > 1)
    ) {
      problems.push({ path: `${path}.restitution`, message: "must be finite in [0, 1]" });
    }
    if (collider.friction !== undefined && !isFiniteNonNegative(collider.friction)) {
      problems.push({ path: `${path}.friction`, message: "must be non-negative and finite" });
    }
  });
  const regionIds = new Set<string>();
  canvas.regions.forEach((region, i) => {
    const path = `regions[${i}]`;
    if (!region.id) problems.push({ path: `${path}.id`, message: "required" });
    if (regionIds.has(region.id)) {
      problems.push({ path: `${path}.id`, message: `duplicate id ${region.id}` });
    }
    regionIds.add(region.id);
    validateRegionShape(region.shape, `${path}.shape`, problems);
    if (region.fieldModifier) {
      validateFieldModifier(region.fieldModifier, `${path}.fieldModifier`, problems);
    }
  });
  if (!finiteVec2(canvas.environment.base.gravityXY)) {
    problems.push({ path: "environment.base.gravityXY", message: "coordinates must be finite" });
  }
  for (const key of ["linearDrag", "angularDrag", "surfaceFrictionMultiplier", "zDrag"] as const) {
    const value = canvas.environment.base[key];
    if (value !== undefined && !isFiniteNonNegative(value)) {
      problems.push({
        path: `environment.base.${key}`,
        message: "must be non-negative and finite",
      });
    }
  }
  for (const key of ["softSpeedLimit"] as const) {
    const value = canvas.environment.base[key];
    if (value !== undefined && value !== null && !isFiniteNonNegative(value)) {
      problems.push({
        path: `environment.base.${key}`,
        message: "must be non-negative and finite or null",
      });
    }
  }
  if (
    canvas.environment.base.zGravity !== undefined &&
    !Number.isFinite(canvas.environment.base.zGravity)
  ) {
    problems.push({ path: "environment.base.zGravity", message: "must be finite" });
  }
  const fieldRegionIds = new Set<string>();
  for (const [i, region] of (canvas.environment.regions ?? []).entries()) {
    const path = `environment.regions[${i}]`;
    if (!region.id) problems.push({ path: `${path}.id`, message: "required" });
    if (fieldRegionIds.has(region.id)) {
      problems.push({ path: `${path}.id`, message: `duplicate id ${region.id}` });
    }
    fieldRegionIds.add(region.id);
    validateRegionShape(region.shape, `${path}.shape`, problems);
    validateFieldModifier(region, path, problems);
  }
  if (canvas.respawn) {
    if (!isFiniteNonNegative(canvas.respawn.delaySeconds)) {
      problems.push({
        path: "respawn.delaySeconds",
        message: "must be a non-negative finite number",
      });
    }
    if (
      canvas.respawn.spawnPointId &&
      !spawnIds.has(canvas.respawn.spawnPointId)
    ) {
      problems.push({ path: "respawn.spawnPointId", message: "must reference a spawn point" });
    }
  }
  if (canvas.systemItems.length > canvas.limits.maxItems) {
    problems.push({
      path: "systemItems",
      message: `item count ${canvas.systemItems.length} exceeds limit ${canvas.limits.maxItems}`,
    });
  }
  const systemItemIds = new Set<string>();
  canvas.systemItems.forEach((item, i) => {
    const path = `systemItems[${i}]`;
    if (!item.entityId) {
      problems.push({ path: `${path}.entityId`, message: "required" });
    } else if (systemItemIds.has(item.entityId)) {
      problems.push({ path: `${path}.entityId`, message: `duplicate id ${item.entityId}` });
    }
    systemItemIds.add(item.entityId);
    if (!item.definitionId) {
      problems.push({ path: `${path}.definitionId`, message: "required" });
    }
    if (!isPositiveUint32(item.definitionVersion)) {
      problems.push({
        path: `${path}.definitionVersion`,
        message: "must be a positive uint32 integer",
      });
    }
    const { x, y, rotation, scale, z } = item.transform;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(rotation) ||
      (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) ||
      (z !== undefined && !Number.isFinite(z)) ||
      x < 0 ||
      x > canvas.size.width ||
      y < 0 ||
      y > canvas.size.height
    ) {
      problems.push({ path: `${path}.transform`, message: "must be finite and inside canvas" });
    }
  });
  const usesRespawn = Object.values(canvas.edges).includes("respawn");
  if (usesRespawn && canvas.spawnPoints.length === 0) {
    problems.push({
      path: "spawnPoints",
      message: "a respawn edge policy needs at least one spawn point",
    });
  }
  return result(problems);
};

export const validateItemDefinition = (
  definition: ItemDefinition,
  knownBehaviorTypes?: ReadonlySet<string>,
): ValidationResult => {
  const problems: Problem[] = [];
  if (!definition.definitionId) problems.push({ path: "definitionId", message: "required" });
  if (!isPositiveUint32(definition.version)) {
    problems.push({ path: "version", message: "must be a positive uint32 integer" });
  }
  if (
    !isFinitePositive(definition.visual.size.width) ||
    !isFinitePositive(definition.visual.size.height)
  ) {
    problems.push({ path: "visual.size", message: "must be positive finite world units" });
  }
  for (const [name, animation] of Object.entries(definition.visual.animations ?? {})) {
    if (!isFinitePositive(animation.fps)) {
      problems.push({
        path: `visual.animations.${name}.fps`,
        message: "must be a positive finite number",
      });
    }
  }
  if (definition.body) {
    const body = definition.body;
    if (body.mass !== undefined && !isFinitePositive(body.mass)) {
      problems.push({ path: "body.mass", message: "must be a positive finite number" });
    }
    if (body.gravityScale !== undefined && !Number.isFinite(body.gravityScale)) {
      problems.push({ path: "body.gravityScale", message: "must be finite" });
    }
    for (const key of ["linearDamping", "angularDamping"] as const) {
      const value = body[key];
      if (value !== undefined && !isFiniteNonNegative(value)) {
        problems.push({ path: `body.${key}`, message: "must be non-negative and finite" });
      }
    }
  }
  const colliderIds = new Set<string>();
  definition.colliders.forEach((collider, i) => {
    const path = `colliders[${i}]`;
    if (!collider.id) {
      problems.push({ path: `${path}.id`, message: "required" });
    }
    if (colliderIds.has(collider.id)) {
      problems.push({ path: `${path}.id`, message: `duplicate id ${collider.id}` });
    }
    colliderIds.add(collider.id);
    validateShape(collider.shape, `${path}.shape`, problems);
    if (
      collider.offset &&
      (!Number.isFinite(collider.offset.x) || !Number.isFinite(collider.offset.y))
    ) {
      problems.push({ path: `${path}.offset`, message: "coordinates must be finite" });
    }
    if (collider.rotation !== undefined && !Number.isFinite(collider.rotation)) {
      problems.push({ path: `${path}.rotation`, message: "must be finite" });
    }
    for (const key of ["collisionMask", "membership"] as const) {
      const value = collider[key];
      if (value !== undefined && !isCollisionBits(value)) {
        problems.push({ path: `${path}.${key}`, message: "must be a uint16 bit mask" });
      }
    }
    if (
      collider.restitution !== undefined &&
      (!Number.isFinite(collider.restitution) || collider.restitution < 0 ||
        collider.restitution > 1)
    ) {
      problems.push({ path: `${path}.restitution`, message: "must be finite in [0, 1]" });
    }
    for (const key of ["friction", "density"] as const) {
      const value = collider[key];
      if (value !== undefined && !isFiniteNonNegative(value)) {
        problems.push({ path: `${path}.${key}`, message: "must be non-negative and finite" });
      }
    }
  });
  if (
    definition.behaviorType &&
    knownBehaviorTypes &&
    !knownBehaviorTypes.has(definition.behaviorType)
  ) {
    problems.push({
      path: "behaviorType",
      message: `unknown behavior type ${definition.behaviorType}`,
    });
  }
  if (definition.persistence.behaviorState && !definition.behaviorType) {
    problems.push({
      path: "persistence.behaviorState",
      message: "durable behavior state needs a behaviorType",
    });
  }
  return result(problems);
};

/** Spec 14.3. Reject NaN and grossly out-of-bounds transforms. */
export const validateTransform = (
  transform: Transform,
  canvas: { size: { width: number; height: number } },
  slackFactor = 4,
): ValidationResult => {
  const problems: Problem[] = [];
  for (const key of ["x", "y", "rotation"] as const) {
    if (!Number.isFinite(transform[key])) {
      problems.push({ path: key, message: "must be a finite number" });
    }
  }
  if (transform.z !== undefined && !Number.isFinite(transform.z)) {
    problems.push({ path: "z", message: "must be a finite number" });
  }
  if (
    transform.scale !== undefined &&
    (!Number.isFinite(transform.scale) || transform.scale <= 0)
  ) {
    problems.push({ path: "scale", message: "must be a positive finite number" });
  }
  const maxX = canvas.size.width * slackFactor;
  const maxY = canvas.size.height * slackFactor;
  if (Math.abs(transform.x) > maxX || Math.abs(transform.y) > maxY) {
    problems.push({ path: "position", message: "grossly out of canvas bounds" });
  }
  return result(problems);
};

export const validateSnapshot = (
  snapshot: CanvasSnapshot,
  canvas: CanvasDefinition,
): ValidationResult => {
  const problems: Problem[] = [];
  if (snapshot.schemaVersion !== SCHEMA_VERSIONS.snapshot) {
    problems.push({
      path: "schemaVersion",
      message: `unsupported snapshot schema ${snapshot.schemaVersion}`,
    });
  }
  if (snapshot.canvasId !== canvas.id) {
    problems.push({ path: "canvasId", message: "does not match the canvas" });
  }
  if (snapshot.canvasVersion !== canvas.version) {
    problems.push({ path: "canvasVersion", message: "does not match the canvas" });
  }
  for (const key of ["sceneRevision", "hostEpoch", "checkpointRevision", "tick"] as const) {
    if (!isNonNegativeSafeInteger(snapshot[key])) {
      problems.push({ path: key, message: "must be a non-negative safe integer" });
    }
  }
  if (snapshot.items.length > canvas.limits.maxItems) {
    problems.push({
      path: "items",
      message: `item count ${snapshot.items.length} exceeds limit ${canvas.limits.maxItems}`,
    });
  }
  const ids = new Set<string>();
  snapshot.items.forEach((item, i) => {
    if (ids.has(item.entityId)) {
      problems.push({ path: `items[${i}].entityId`, message: "duplicate entity id" });
    }
    ids.add(item.entityId);
    if (!isPositiveUint32(item.definitionVersion)) {
      problems.push({
        path: `items[${i}].definitionVersion`,
        message: "must be a positive uint32 integer",
      });
    }
    if (!Number.isSafeInteger(item.itemRevision) || item.itemRevision < 1) {
      problems.push({
        path: `items[${i}].itemRevision`,
        message: "must be a positive safe integer",
      });
    }
    const transform = validateTransform(item.transform, canvas);
    if (!transform.ok) {
      for (const problem of transform.problems) {
        problems.push({ path: `items[${i}].transform.${problem.path}`, message: problem.message });
      }
    }
    const timers = item.behaviorTimers ?? [];
    if (snapshot.normalized && timers.length > 0) {
      problems.push({
        path: `items[${i}].behaviorTimers`,
        message: "sleep-normalized snapshots cannot contain active timers",
      });
    }
    if (timers.length > 64) {
      problems.push({
        path: `items[${i}].behaviorTimers`,
        message: "contains more than 64 timers",
      });
    }
    timers.forEach((timer, timerIndex) => {
      const path = `items[${i}].behaviorTimers[${timerIndex}]`;
      if (!timer.key || timer.key.length > 128) {
        problems.push({ path: `${path}.key`, message: "must be 1 to 128 characters" });
      }
      if (!Number.isSafeInteger(timer.elapsedTicks) || timer.elapsedTicks < 0) {
        problems.push({ path: `${path}.elapsedTicks`, message: "must be a non-negative integer" });
      }
      if (!Number.isSafeInteger(timer.remainingTicks) || timer.remainingTicks < 1) {
        problems.push({ path: `${path}.remainingTicks`, message: "must be a positive integer" });
      }
    });
  });
  snapshot.avatars.forEach((avatar, i) => {
    if (ids.has(avatar.entityId)) {
      problems.push({ path: `avatars[${i}].entityId`, message: "duplicate entity id" });
    }
    ids.add(avatar.entityId);
    if (!avatar.entityId || !avatar.userId) {
      problems.push({ path: `avatars[${i}]`, message: "entity and user ids are required" });
    }
    const transform = validateTransform(
      { x: avatar.position.x, y: avatar.position.y, rotation: 0 },
      canvas,
    );
    if (!transform.ok) {
      for (const problem of transform.problems) {
        problems.push({ path: `avatars[${i}].position.${problem.path}`, message: problem.message });
      }
    }
  });
  return result(problems);
};
