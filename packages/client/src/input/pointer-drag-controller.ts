import type { Vec2 } from "@canvas-physics/core";

export interface DragIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
}

/** The on-screen state of the drag, in element pixels, for the overlay. */
export interface DragGesture {
  /** Where the pointer went down. */
  origin: Vec2;
  /** Where the pointer is now. */
  point: Vec2;
  /** Distance in pixels that maps to full intensity. */
  rangePx: number;
  intensity: number;
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
  private originLocal?: Vec2;
  private pointLocal?: Vec2;
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
      this.originLocal = this.toLocal(event);
      this.pointLocal = { ...this.originLocal };
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: true };
    };
    const onMove = (event: PointerEvent) => {
      if (!this.origin) return;
      this.pointLocal = this.toLocal(event);
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
      this.originLocal = undefined;
      this.pointLocal = undefined;
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

  /**
   * Spec 6.1. The overlay shows the centre of the drag and its direction, so the
   * player can see what the gesture means.
   */
  get gesture(): DragGesture | undefined {
    if (!this.originLocal || !this.pointLocal) return undefined;
    return {
      origin: { ...this.originLocal },
      point: { ...this.pointLocal },
      rangePx: this.fullRangePx + this.deadZonePx,
      intensity: this.current.intensity,
    };
  }

  private toLocal(event: PointerEvent): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  destroy(): void {
    this.detach();
  }
}
