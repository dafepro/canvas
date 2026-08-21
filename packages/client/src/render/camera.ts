import type { CanvasDefinition } from "@canvas-physics/core";

/** Maps world units to screen pixels (spec 2.2). */
export class Camera {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  constructor(private readonly canvas: CanvasDefinition) {}

  /** Fits the whole canvas into the viewport and centres it. */
  fit(viewportWidth: number, viewportHeight: number): void {
    const { width, height } = this.canvas.size;
    this.scale = Math.min(viewportWidth / width, viewportHeight / height);
    this.offsetX = (viewportWidth - width * this.scale) / 2;
    this.offsetY = (viewportHeight - height * this.scale) / 2;
  }

  toScreenX(worldX: number): number {
    return this.offsetX + worldX * this.scale;
  }

  toScreenY(worldY: number): number {
    return this.offsetY + worldY * this.scale;
  }

  toWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.offsetX) / this.scale,
      y: (screenY - this.offsetY) / this.scale,
    };
  }
}
