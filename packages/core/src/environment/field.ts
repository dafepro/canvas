import { clamp, lerp, lerpVec2, type Vec2 } from "../math/vec2.js";
import type {
  EnvironmentBase,
  EnvironmentDefinition,
  FieldBlend,
  FieldValue,
  RegionFieldModifier,
} from "../model/canvas-definition.js";
import type { RegionShape } from "../model/shapes.js";
import { regionContains } from "../model/shapes.js";

/** Spec 4.1. Sampled for each affected body during each simulation step. */
export interface EnvironmentSample {
  gravityXY: Vec2;
  linearDrag: number;
  angularDrag: number;
  softSpeedLimit: number | null;
  surfaceFrictionMultiplier: number;
  /** Optional top-down 2.5D channel. */
  zGravity: number;
  zDrag: number;
}

type ModifierRegion = RegionFieldModifier & { id: string; shape: RegionShape };

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Blend weight in [0, 1] for a position inside a region. */
const blendWeight = (
  modifier: RegionFieldModifier,
  shape: RegionShape,
  p: Vec2,
): number => {
  const mode: FieldBlend = modifier.blend;
  if (mode === "step") return 1;

  if (mode === "radial") {
    if (shape.type !== "circle") return 1;
    const distance = Math.hypot(p.x - shape.x, p.y - shape.y);
    return clamp(1 - distance / shape.radius, 0, 1);
  }

  const axis = modifier.axis ?? "y";
  const value = axis === "x" ? p.x : p.y;
  const from = modifier.from ?? (shape.type === "rect" ? (axis === "x" ? shape.x : shape.y) : 0);
  const to =
    modifier.to ??
    (shape.type === "rect"
      ? axis === "x"
        ? shape.x + shape.w
        : shape.y + shape.h
      : 1);
  if (from === to) return 1;
  const t = clamp((value - from) / (to - from), 0, 1);
  return mode === "smoothstep" ? smoothstep(t) : t;
};

const resolveNumber = (
  field: FieldValue<number> | undefined,
  weight: number,
  current: number,
): number => {
  if (field === undefined) return current;
  if (Array.isArray(field)) return lerp(field[0], field[1], weight);
  return lerp(current, field, weight);
};

const resolveNullableNumber = (
  field: FieldValue<number | null> | undefined,
  weight: number,
  current: number | null,
): number | null => {
  if (field === undefined) return current;
  if (Array.isArray(field)) {
    const [from, to] = field;
    if (from === null) return to === null ? null : lerp(current ?? to, to, weight);
    if (to === null) return weight >= 1 ? null : from;
    return lerp(from, to, weight);
  }
  if (field === null) return weight >= 1 ? null : current;
  return current === null ? field : lerp(current, field, weight);
};

const resolveVec2 = (
  field: FieldValue<Vec2> | undefined,
  weight: number,
  current: Vec2,
): Vec2 => {
  if (field === undefined) return current;
  if (Array.isArray(field)) return lerpVec2(field[0], field[1], weight);
  return lerpVec2(current, field, weight);
};

const baseSample = (base: EnvironmentBase): EnvironmentSample => ({
  gravityXY: { ...base.gravityXY },
  linearDrag: base.linearDrag,
  angularDrag: base.angularDrag ?? 0,
  softSpeedLimit: base.softSpeedLimit ?? null,
  surfaceFrictionMultiplier: base.surfaceFrictionMultiplier ?? 1,
  zGravity: base.zGravity ?? 0,
  zDrag: base.zDrag ?? 0,
});

/**
 * Samples the canvas defaults and blends in every region modifier that contains
 * the point. Modifiers apply in priority order, low priority first.
 */
export class EnvironmentField {
  private readonly regions: ModifierRegion[];

  constructor(private readonly definition: EnvironmentDefinition) {
    this.regions = [...(definition.regions ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  sample(p: Vec2, into?: EnvironmentSample): EnvironmentSample {
    const out = into ?? baseSample(this.definition.base);
    if (into) {
      const base = this.definition.base;
      out.gravityXY.x = base.gravityXY.x;
      out.gravityXY.y = base.gravityXY.y;
      out.linearDrag = base.linearDrag;
      out.angularDrag = base.angularDrag ?? 0;
      out.softSpeedLimit = base.softSpeedLimit ?? null;
      out.surfaceFrictionMultiplier = base.surfaceFrictionMultiplier ?? 1;
      out.zGravity = base.zGravity ?? 0;
      out.zDrag = base.zDrag ?? 0;
    }

    for (const region of this.regions) {
      if (!regionContains(region.shape, p)) continue;
      const weight = blendWeight(region, region.shape, p);
      if (weight <= 0) continue;

      if (region.gravityScale !== undefined) {
        const scale = resolveNumber(region.gravityScale, weight, 1);
        out.gravityXY = { x: out.gravityXY.x * scale, y: out.gravityXY.y * scale };
      }
      out.gravityXY = resolveVec2(region.gravityXY, weight, out.gravityXY);
      out.linearDrag = resolveNumber(region.linearDrag, weight, out.linearDrag);
      out.angularDrag = resolveNumber(region.angularDrag, weight, out.angularDrag);
      out.softSpeedLimit = resolveNullableNumber(
        region.softSpeedLimit,
        weight,
        out.softSpeedLimit,
      );
      out.surfaceFrictionMultiplier = resolveNumber(
        region.surfaceFrictionMultiplier,
        weight,
        out.surfaceFrictionMultiplier,
      );
      out.zGravity = resolveNumber(region.zGravity, weight, out.zGravity);
      out.zDrag = resolveNumber(region.zDrag, weight, out.zDrag);
    }

    return out;
  }

  /** Region ids that contain the point, for region enter and exit events. */
  regionsAt(p: Vec2): string[] {
    return this.regions
      .filter((region) => regionContains(region.shape, p))
      .map((region) => region.id);
  }
}

/**
 * Spec 4.1. A soft speed limit adds drag only to the velocity above the
 * threshold. It never clamps, so motion stays smooth across the network.
 */
export const softSpeedLimitForce = (
  velocity: Vec2,
  limit: number | null,
  strength = 4,
): Vec2 => {
  if (limit === null || limit <= 0) return { x: 0, y: 0 };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= limit) return { x: 0, y: 0 };
  const excess = speed - limit;
  const scale = (-strength * excess) / speed;
  return { x: velocity.x * scale, y: velocity.y * scale };
};
