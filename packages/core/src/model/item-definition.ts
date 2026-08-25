import type { Vec2 } from "../math/vec2.js";
import type { ColliderRole } from "./collision.js";
import type { ShapeDefinition } from "./shapes.js";

export type BodyMode = "fixed" | "dynamic" | "kinematicVelocity" | "kinematicPosition";

export interface RigidBodyDefinition {
  mode: BodyMode;
  mass?: number;
  gravityScale?: number;
  linearDamping?: number;
  angularDamping?: number;
  canSleep?: boolean;
  lockRotation?: boolean;
}

export interface ColliderDefinition {
  id: string;
  role: ColliderRole;
  shape: ShapeDefinition;
  offset?: Vec2;
  rotation?: number;
  /** Overrides the role default. See roleDefaultMask. */
  collisionMask?: number;
  membership?: number;
  sensor?: boolean;
  restitution?: number;
  friction?: number;
  density?: number;
  enabled?: boolean;
  tags?: string[];
}

export interface VisualDefinition {
  /** Sprite atlas key, or a placeholder shape when no asset exists. */
  spriteId?: string;
  placeholder?: { shape: "circle" | "rect" | "triangle"; color: number };
  /** World-unit size. Sprite source pixels may be any size (spec 2.2). */
  size: { width: number; height: number };
  anchor?: Vec2;
  /** Reflect source art horizontally while preserving world dimensions. */
  mirrorX?: boolean;
  /** Reflect source art vertically while preserving world dimensions. */
  mirrorY?: boolean;
  zIndex?: number;
  variants?: Record<string, { spriteId?: string; color?: number }>;
  animations?: Record<string, AnimationDefinition>;
}

export interface AnimationDefinition {
  frames: string[];
  fps: number;
  loop: boolean;
}

/** Spec 4.3. Elevation is a scalar channel, not a 3D body. */
export interface ElevationDefinition {
  enabled: boolean;
  groundZ?: number;
  restitution?: number;
  /** Scale applied to the sprite for each world unit of Z. */
  scalePerZ?: number;
  shadow?: boolean;
}

/** Spec 7.3. Data-only tuning; the backend can validate it without game code. */
export interface TuningRule {
  when: TuningCondition;
  overrides: Record<string, unknown>;
}

export interface TuningCondition {
  minCanvasWidth?: number;
  maxCanvasWidth?: number;
  minCanvasHeight?: number;
  maxCanvasHeight?: number;
  orientation?: "topDown" | "side";
  canvasTag?: string;
}

export interface ItemPersistenceRules {
  transform: boolean;
  behaviorState: boolean;
  onRoomSleep: "resetToIdle" | "pause";
}

/** Spec 7.1. */
export interface ItemDefinition<Config = unknown> {
  definitionId: string;
  version: number;
  displayName: string;
  visual: VisualDefinition;
  body?: RigidBodyDefinition;
  colliders: ColliderDefinition[];
  elevation?: ElevationDefinition;
  behaviorType?: string;
  configSchemaId?: string;
  defaultConfig?: Config;
  tuningRules?: TuningRule[];
  persistence: ItemPersistenceRules;
  complexity: "simple" | "complex";
}
