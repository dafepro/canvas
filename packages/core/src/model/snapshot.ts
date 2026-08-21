import type { Transform } from "./item-instance.js";

/**
 * A durable canonical checkpoint (spec 13.1). Velocities, forces, particles,
 * contact sets, and avatars are not part of it.
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
}

export interface SnapshotItem {
  entityId: string;
  definitionId: string;
  definitionVersion: number;
  ownerUserId: string;
  transform: Transform;
  resolvedConfig: unknown;
  /** Present only when the item definition declares behaviorState durable. */
  behaviorState?: unknown;
  behaviorStateVersion?: number;
  /** Persistent visual variant needed to rebuild the item. */
  visualVariant?: string;
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
});
