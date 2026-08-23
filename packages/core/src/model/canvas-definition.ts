import type { Vec2 } from "../math/vec2.js";
import type { ColliderRole, TerrainBlocking } from "./collision.js";
import type { RegionShape, ShapeDefinition } from "./shapes.js";

/** Spec 3.2. */
export type EdgePolicy = "solid" | "wrap" | "respawn" | "open";

export type CanvasOrientation = "topDown" | "side";

export interface StaticColliderDefinition {
  id: string;
  shape: ShapeDefinition;
  position: Vec2;
  rotation?: number;
  /** Sensor-only static geometry triggers events without blocking motion. */
  role?: Extract<ColliderRole, "worldStatic" | "regionSensor">;
  restitution?: number;
  friction?: number;
  /** Semantic tags such as "hill", "launchPad", "goal", "ground". */
  tags?: string[];
  /**
   * Addendum A4. Which body kinds this terrain stops. It overrides
   * `CanvasDefinition.terrainDefaults` for this collider alone.
   */
  blocks?: TerrainBlocking;
}

export interface RegionDefinition {
  id: string;
  shape: RegionShape;
  tags?: string[];
  /** Emit region.enter and region.exit events for bodies inside the shape. */
  emitEvents?: boolean;
  fieldModifier?: RegionFieldModifier;
}

/** Spec 4.1. A field value is a constant or a pair blended across the region. */
export type FieldValue<T> = T | [from: T, to: T];

export type FieldBlend = "step" | "linear" | "smoothstep" | "radial";

export interface RegionFieldModifier {
  blend: FieldBlend;
  /** Blend axis for linear and smoothstep modes. */
  axis?: "x" | "y";
  /** World coordinate where the blend starts. */
  from?: number;
  /** World coordinate where the blend ends. */
  to?: number;
  priority: number;
  gravityScale?: FieldValue<number>;
  gravityXY?: FieldValue<Vec2>;
  linearDrag?: FieldValue<number>;
  angularDrag?: FieldValue<number>;
  softSpeedLimit?: FieldValue<number | null>;
  surfaceFrictionMultiplier?: FieldValue<number>;
  zGravity?: FieldValue<number>;
  zDrag?: FieldValue<number>;
}

export interface EnvironmentBase {
  gravityXY: Vec2;
  linearDrag: number;
  angularDrag?: number;
  softSpeedLimit?: number | null;
  surfaceFrictionMultiplier?: number;
  /** Optional top-down 2.5D channel (spec 4.3). */
  zGravity?: number;
  zDrag?: number;
}

export interface EnvironmentDefinition {
  base: EnvironmentBase;
  regions?: (RegionFieldModifier & { id: string; shape: RegionShape })[];
}

export interface SpawnPoint {
  id: string;
  position: Vec2;
  rotation?: number;
}

export interface CanvasLimits {
  maxAvatars: number;
  maxItems: number;
  maxComplexPhysicsItems: number;
}

/** Canvas-owned defaults for every participant avatar in the room. */
export interface AvatarControllerDefinition {
  radius?: number;
  maxSpeed?: number;
  acceleration?: number;
}

export const defaultAvatarController: Required<AvatarControllerDefinition> = {
  radius: 1.2,
  maxSpeed: 18,
  acceleration: 90,
};

export const resolveAvatarController = (
  configured?: AvatarControllerDefinition,
): Required<AvatarControllerDefinition> => ({
  ...defaultAvatarController,
  ...configured,
});

/** An immutable room-owned item materialized when no snapshot exists yet. */
export interface SystemItemDefinition {
  entityId: string;
  definitionId: string;
  definitionVersion: number;
  transform: { x: number; y: number; rotation: number; z?: number };
  resolvedConfig: unknown;
}

/** Addendum A3. What happens between the loss of a body and its return. */
export interface RespawnPolicy {
  /** Seconds the body stays out of the scene. Zero returns it at once. */
  delaySeconds: number;
  /** The spawn point to use. The first spawn point is the default. */
  spawnPointId?: string;
  /** Apply the same delay to a body the host had to quarantine. */
  applyToQuarantine?: boolean;
}

export const defaultRespawnPolicy: RespawnPolicy = {
  delaySeconds: 1.5,
  applyToQuarantine: true,
};

export const defaultCanvasLimits: CanvasLimits = {
  maxAvatars: 20,
  maxItems: 50,
  maxComplexPhysicsItems: 5,
};

/** Spec 3.1. */
export interface CanvasDefinition {
  id: string;
  version: number;
  size: { width: number; height: number };
  orientation: CanvasOrientation;
  backgroundAssetId?: string;
  edges: {
    top: EdgePolicy;
    right: EdgePolicy;
    bottom: EdgePolicy;
    left: EdgePolicy;
  };
  staticGeometry: StaticColliderDefinition[];
  regions: RegionDefinition[];
  environment: EnvironmentDefinition;
  spawnPoints: SpawnPoint[];
  /** Baseline items owned by the room, never by the first participant. */
  systemItems: SystemItemDefinition[];
  limits: CanvasLimits;
  /** Movement tuning shared by host simulation and local prediction. */
  avatarController?: AvatarControllerDefinition;
  /**
   * Addendum A4. The blocking rule for every static collider that states none.
   * The library default lets an avatar pass through terrain.
   */
  terrainDefaults?: TerrainBlocking;
  /** Addendum A3. The delayed return of a body that left the canvas. */
  respawn?: RespawnPolicy;
}
