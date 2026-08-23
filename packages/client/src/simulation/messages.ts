import type {
  CanvasDefinition,
  CanvasSnapshot,
  EffectEmission,
  ItemDefinition,
  ItemInstance,
  Transform,
  Vec2,
} from "@canvas-physics/core";
import type { AvatarSpawn } from "./rapier-world.js";

/** Messages the main thread sends to the simulation worker. */
export type SimulationRequest =
  | {
      type: "init";
      canvas: CanvasDefinition;
      definitions: ItemDefinition[];
      tickRate: number;
      /** True when this client holds the host lease. */
      isHost: boolean;
      snapshot?: CanvasSnapshot;
      wakeFromSleep?: boolean;
      localAvatar?: AvatarSpawn;
    }
  | {
      type: "setHost";
      isHost: boolean;
      snapshot?: CanvasSnapshot;
      wakeFromSleep?: boolean;
    }
  | { type: "addItem"; instance: ItemInstance }
  | { type: "removeItem"; entityId: string }
  | { type: "addAvatar"; spawn: AvatarSpawn }
  | { type: "removeAvatar"; entityId: string }
  | {
      type: "input";
      entityId: string;
      direction: Vec2;
      intensity: number;
      inputSequence: number;
      /** Addendum A1. True while the client asks for a disabled avatar. */
      disabled?: boolean;
    }
  | { type: "ownerAction"; entityId: string; action: string; userId: string }
  | { type: "moveItem"; entityId: string; transform: Transform; preview: boolean }
  | { type: "setItemConfig"; entityId: string; config: unknown }
  | {
      type: "requestSnapshot";
      final: boolean;
      sceneRevision: number;
      hostEpoch: number;
    }
  | { type: "stop" };

export interface RenderEntity {
  id: string;
  kind: "avatar" | "item" | "static" | "region";
  definitionId: string;
  x: number;
  y: number;
  rotation: number;
  z?: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  variant?: string;
  animation?: string;
  userId?: string;
  ownerUserId?: string;
  lastProcessedInputSequence?: number;
  behaviorState?: unknown;
  quarantined?: boolean;
  /** Addendum A1. True when no physics act on this avatar. */
  disabled?: boolean;
  /**
   * Addendum A2. Rises on every discontinuous move. A renderer that sees a new
   * value snaps the sprite instead of interpolating across the canvas.
   */
  teleportEpoch?: number;
  /** Addendum A3. True while the body waits out its respawn delay. */
  respawning?: boolean;
}

export interface SimulationStats {
  hz: number;
  driftMs: number;
  worstStepMs: number;
  awakeBodies: number;
  behaviorErrors: number;
  /** Spec 19.1. The scene budget is 150 active colliders. */
  activeColliders: number;
}

/** Messages the simulation worker sends back to the main thread. */
export type SimulationResponse =
  | { type: "ready" }
  | {
      type: "render";
      tick: number;
      isHost: boolean;
      entities: RenderEntity[];
      stats: SimulationStats;
    }
  | { type: "effects"; tick: number; effects: EffectEmission[] }
  | { type: "snapshot"; snapshot: CanvasSnapshot; final: boolean }
  | { type: "error"; message: string };
