import type { Vec2 } from "../math/vec2.js";
import type { Transform } from "./item-instance.js";

/**
 * A durable canonical checkpoint (spec 13.1). Velocities, forces, particles,
 * contact sets, and forces are not part of it. Avatar positions are durable so
 * reconnecting participants resume from the room's last canonical location.
 */
export interface CanvasSnapshot {
  schemaVersion: number;
  canvasId: string;
  canvasVersion: number;
  sceneRevision: number;
  /** Host epoch that produced the checkpoint, for recovery bookkeeping. */
  hostEpoch: number;
  checkpointRevision: number;
  /** Host simulation tick at capture time. */
  tick: number;
  capturedAt: string;
  /** True after the room sleep normalization ran. */
  normalized: boolean;
  items: SnapshotItem[];
  avatars: SnapshotAvatar[];
}

export interface SnapshotAvatar {
  entityId: string;
  userId: string;
  position: Vec2;
}

export interface SnapshotItem {
  entityId: string;
  definitionId: string;
  definitionVersion: number;
  ownerUserId: string;
  transform: Transform;
  /** Durable owner-controlled simulation isolation. */
  isolated?: boolean;
  collisionsDisabled?: boolean;
  resolvedConfig: unknown;
  /** Present only when the item definition declares behaviorState durable. */
  behaviorState?: unknown;
  behaviorStateVersion?: number;
  /** Active timers used only to resume a live host migration. */
  behaviorTimers?: BehaviorTimerSnapshot[];
  /** Persistent visual variant needed to rebuild the item. */
  visualVariant?: string;
  /** Persistent behavior-authored multiplicative sprite tint. */
  visualTint?: number;
}

export interface BehaviorTimerSnapshot {
  key: string;
  elapsedTicks: number;
  remainingTicks: number;
}

export const emptySnapshot = (
  canvasId: string,
  canvasVersion: number,
): CanvasSnapshot => ({
  schemaVersion: 1,
  canvasId,
  canvasVersion,
  sceneRevision: 0,
  hostEpoch: 0,
  checkpointRevision: 0,
  tick: 0,
  capturedAt: new Date(0).toISOString(),
  normalized: true,
  items: [],
  avatars: [],
});
