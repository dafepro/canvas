import { describe, expect, it } from "vitest";
import { PointerDragController } from "../src/input/pointer-drag-controller.js";

class PointerSurface {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured?: number;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener as (event: PointerEvent) => void);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as (event: PointerEvent) => void);
  }

  setPointerCapture(pointerId: number): void {
    this.captured = pointerId;
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captured === pointerId;
  }

  releasePointerCapture(pointerId: number): void {
    if (this.captured === pointerId) this.captured = undefined;
  }

  getBoundingClientRect(): DOMRect {
    return { left: 10, top: 20 } as DOMRect;
  }

  emit(type: string, x: number, y: number, pointerId = 7): void {
    const event = {
      pointerId,
      clientX: x + 10,
      clientY: y + 20,
      preventDefault: () => {},
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("PointerDragController", () => {
  it("keeps thumbstick drag as the default input mode", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      deadZonePx: 0,
      fullRangePx: 40,
    });

    surface.emit("pointerdown", 20, 20);
    surface.emit("pointermove", 40, 20);

    expect(controller.intent).toEqual({
      direction: { x: 1, y: 0 },
      intensity: 0.5,
      held: true,
    });
    expect(controller.gesture).toMatchObject({
      origin: { x: 20, y: 20 },
      point: { x: 40, y: 20 },
    });
    controller.destroy();
  });

  it("starts avatar drag only when the pointer grabs the local avatar", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
    });

    surface.emit("pointerdown", 10, 10);

    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: false,
    });
    expect(surface.captured).toBeUndefined();
    controller.destroy();
  });

  it("drives the avatar toward the dragged target and stops when it catches up", () => {
    const surface = new PointerSurface();
    let avatar = { x: 50, y: 40 };
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => avatar,
      grabRadiusPx: 24,
      deadZonePx: 2,
      fullRangePx: 20,
    });

    // Grab four pixels right of centre, then drag 12 pixels right. Retaining the
    // grab offset makes the avatar's target 12 pixels right of its centre.
    surface.emit("pointerdown", 54, 40);
    surface.emit("pointermove", 66, 40);

    expect(controller.intent).toEqual({
      direction: { x: 1, y: 0 },
      intensity: 0.5,
      held: true,
    });
    expect(controller.gesture).toBeUndefined();

    avatar = { x: 62, y: 40 };
    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: true,
    });

    surface.emit("pointerup", 66, 40);
    expect(controller.intent.held).toBe(false);
    controller.destroy();
  });
});
