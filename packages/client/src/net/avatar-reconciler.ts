import type { Vec2 } from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";

export interface ReconcilerOptions {
  /** Error above this distance snaps instead of blending, in world units. */
  snapDistance?: number;
  /** Fraction of the remaining error removed each frame. */
  blendPerFrame?: number;
}

/**
 * Spec 6.2. Compares the canonical avatar position with the local prediction.
 * A small error blends over several frames; a large error snaps.
 */
export class AvatarReconciler {
  private targetOffset: Vec2 = { x: 0, y: 0 };
  private appliedOffset: Vec2 = { x: 0, y: 0 };
  private lastTeleportEpoch?: number;
  lastErrorDistance = 0;
  snapCount = 0;

  private readonly snapDistance: number;
  private readonly blendPerFrame: number;

  constructor(options: ReconcilerOptions = {}) {
    this.snapDistance = options.snapDistance ?? 3;
    this.blendPerFrame = options.blendPerFrame ?? 0.1;
  }

  /**
   * Records the newest canonical state for the local avatar. Addendum A2. The
   * host may have wrapped or respawned the avatar. That is not a prediction
   * error, so the canonical place is used at once.
   */
  observe(canonical: RenderEntity, predicted: { x: number; y: number }): void {
    const epoch = canonical.teleportEpoch ?? 0;
    const errorX = canonical.x - predicted.x;
    const errorY = canonical.y - predicted.y;
    if (this.lastTeleportEpoch !== undefined && epoch !== this.lastTeleportEpoch) {
      this.lastTeleportEpoch = epoch;
      this.targetOffset = { x: errorX, y: errorY };
      this.appliedOffset = { x: errorX, y: errorY };
      this.lastErrorDistance = 0;
      this.snapCount++;
      return;
    }
    this.lastTeleportEpoch = epoch;
    this.lastErrorDistance = Math.hypot(errorX, errorY);

    if (this.lastErrorDistance > this.snapDistance) {
      this.targetOffset = { x: errorX, y: errorY };
      this.appliedOffset = { x: errorX, y: errorY };
      this.snapCount++;
      return;
    }
    this.targetOffset = { x: errorX, y: errorY };
  }

  /** The corrected display position for the local avatar. */
  correct(predicted: { x: number; y: number }): Vec2 {
    this.appliedOffset = {
      x: this.appliedOffset.x +
        (this.targetOffset.x - this.appliedOffset.x) * this.blendPerFrame,
      y: this.appliedOffset.y +
        (this.targetOffset.y - this.appliedOffset.y) * this.blendPerFrame,
    };
    return {
      x: predicted.x + this.appliedOffset.x,
      y: predicted.y + this.appliedOffset.y,
    };
  }

  reset(): void {
    this.targetOffset = { x: 0, y: 0 };
    this.appliedOffset = { x: 0, y: 0 };
    this.lastErrorDistance = 0;
    this.lastTeleportEpoch = undefined;
  }
}
