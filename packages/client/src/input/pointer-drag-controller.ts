import type { Vec2 } from "@canvas-physics/core";

export interface DragIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
}

export interface PointerDragOptions {
  /** Drag distance in pixels that maps to full intensity. */
  fullRangePx?: number;
  /** Dead zone in pixels. */
  deadZonePx?: number;
}

/**
 * Spec 6.1. Treats touch and click-drag as movement intent, never as an
 * authoritative position, so a pointer jump cannot teleport through a wall.
 */
export class PointerDragController {
  private origin?: { x: number; y: number };
  private current: DragIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };
  private readonly fullRangePx: number;
  private readonly deadZonePx: number;
  private readonly detach: () => void;

  constructor(
    private readonly element: HTMLElement,
    options: PointerDragOptions = {},
  ) {
    this.fullRangePx = options.fullRangePx ?? 90;
    this.deadZonePx = options.deadZonePx ?? 6;

    const onDown = (event: PointerEvent) => {
      this.element.setPointerCapture(event.pointerId);
      this.origin = { x: event.clientX, y: event.clientY };
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: true };
    };
    const onMove = (event: PointerEvent) => {
      if (!this.origin) return;
      const dx = event.clientX - this.origin.x;
      const dy = event.clientY - this.origin.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= this.deadZonePx) {
        this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: true };
        return;
      }
      const intensity = Math.min(1, (distance - this.deadZonePx) / this.fullRangePx);
      this.current = {
        direction: { x: dx / distance, y: dy / distance },
        intensity,
        held: true,
      };
    };
    const onUp = (event: PointerEvent) => {
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.origin = undefined;
      // Release decelerates to zero through avatar drag.
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: false };
    };

    this.element.addEventListener("pointerdown", onDown);
    this.element.addEventListener("pointermove", onMove);
    this.element.addEventListener("pointerup", onUp);
    this.element.addEventListener("pointercancel", onUp);
    this.detach = () => {
      this.element.removeEventListener("pointerdown", onDown);
      this.element.removeEventListener("pointermove", onMove);
      this.element.removeEventListener("pointerup", onUp);
      this.element.removeEventListener("pointercancel", onUp);
    };
  }

  get intent(): DragIntent {
    return this.current;
  }

  destroy(): void {
    this.detach();
  }
}
