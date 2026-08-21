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
  private offset: Vec2 = { x: 0, y: 0 };
  lastErrorDistance = 0;
  snapCount = 0;

  private readonly snapDistance: number;
  private readonly blendPerFrame: number;

  constructor(options: ReconcilerOptions = {}) {
    this.snapDistance = options.snapDistance ?? 3;
    this.blendPerFrame = options.blendPerFrame ?? 0.2;
  }

  /** Records the newest canonical state for the local avatar. */
  observe(canonical: RenderEntity, predicted: { x: number; y: number }): void {
    const errorX = canonical.x - predicted.x;
    const errorY = canonical.y - predicted.y;
    this.lastErrorDistance = Math.hypot(errorX, errorY);

    if (this.lastErrorDistance > this.snapDistance) {
      this.offset = { x: errorX, y: errorY };
      this.snapCount++;
      return;
    }
    this.offset = { x: errorX, y: errorY };
  }

  /** The corrected display position for the local avatar. */
  correct(predicted: { x: number; y: number }): Vec2 {
    const corrected = {
      x: predicted.x + this.offset.x,
      y: predicted.y + this.offset.y,
    };
    this.offset = {
      x: this.offset.x * (1 - this.blendPerFrame),
      y: this.offset.y * (1 - this.blendPerFrame),
    };
    return corrected;
  }

  reset(): void {
    this.offset = { x: 0, y: 0 };
    this.lastErrorDistance = 0;
  }
}
