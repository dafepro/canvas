import type { CanvasDefinition } from "../model/canvas-definition.js";
import type { ItemDefinition } from "../model/item-definition.js";
import type { Transform } from "../model/item-instance.js";
import type { CanvasSnapshot } from "../model/snapshot.js";

export interface Problem {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; problems: Problem[] };

const result = (problems: Problem[]): ValidationResult =>
  problems.length === 0 ? { ok: true } : { ok: false, problems };

export const validateCanvasDefinition = (
  canvas: CanvasDefinition,
): ValidationResult => {
  const problems: Problem[] = [];
  if (!canvas.id) problems.push({ path: "id", message: "required" });
  if (canvas.version < 1) problems.push({ path: "version", message: "must be >= 1" });
  if (canvas.size.width <= 0 || canvas.size.height <= 0) {
    problems.push({ path: "size", message: "width and height must be positive" });
  }
  if (canvas.limits.maxItems < 0) {
    problems.push({ path: "limits.maxItems", message: "must be >= 0" });
  }
  for (const key of ["radius", "maxSpeed", "acceleration"] as const) {
    const value = canvas.avatarController?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      problems.push({
        path: `avatarController.${key}`,
        message: "must be a positive finite number",
      });
    }
  }
  const spawnIds = new Set<string>();
  canvas.spawnPoints.forEach((spawn, i) => {
    if (spawnIds.has(spawn.id)) {
      problems.push({ path: `spawnPoints[${i}].id`, message: `duplicate id ${spawn.id}` });
    }
    spawnIds.add(spawn.id);
  });
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
    if (item.definitionVersion < 1) {
      problems.push({ path: `${path}.definitionVersion`, message: "must be >= 1" });
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
  if (definition.version < 1) problems.push({ path: "version", message: "must be >= 1" });
  if (definition.visual.size.width <= 0 || definition.visual.size.height <= 0) {
    problems.push({ path: "visual.size", message: "must be positive world units" });
  }
  const colliderIds = new Set<string>();
  definition.colliders.forEach((collider, i) => {
    if (colliderIds.has(collider.id)) {
      problems.push({ path: `colliders[${i}].id`, message: `duplicate id ${collider.id}` });
    }
    colliderIds.add(collider.id);
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
  if (snapshot.canvasId !== canvas.id) {
    problems.push({ path: "canvasId", message: "does not match the canvas" });
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
