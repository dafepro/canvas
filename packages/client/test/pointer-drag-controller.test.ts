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

  emit(
    type: string,
    x: number,
    y: number,
    pointerId = 7,
    timeStamp = 0,
    buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1,
    init: Partial<PointerEvent> = {},
  ): void {
    const event = {
      pointerId,
      clientX: x + 10,
      clientY: y + 20,
      timeStamp,
      buttons,
      pointerType: "mouse",
      relatedTarget: this,
      preventDefault: () => {},
      ...init,
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class WindowTrackedPointerSurface extends PointerSurface {
  readonly windowTarget = new PointerSurface();
  readonly ownerDocument = {
    defaultView: this.windowTarget as unknown as Window,
  };
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

  it("does not start movement when a live editor owns that pointer location", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      deadZonePx: 0,
      fullRangePx: 40,
      allowStart: (point) => point.x > 30,
    });

    surface.emit("pointerdown", 20, 20);
    surface.emit("pointermove", 60, 20);

    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: false,
    });
    expect(surface.captured).toBeUndefined();
    controller.destroy();
  });

  it("places the avatar target exactly under the pointer without retaining a grab offset", () => {
    const surface = new PointerSurface();
    let avatar = { x: 50, y: 40 };
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => avatar,
      grabRadiusPx: 24,
      deadZonePx: 2,
      fullRangePx: 20,
    });

    // Grabbing off-centre still puts the avatar centre directly under the
    // pointer instead of retaining the original four-pixel grab offset.
    surface.emit("pointerdown", 54, 40);
    surface.emit("pointermove", 66, 40);

    expect(controller.intent).toEqual({
      direction: { x: 1, y: 0 },
      intensity: 0.7,
      held: true,
      target: { x: 66, y: 40 },
    });
    expect(controller.gesture).toBeUndefined();

    avatar = { x: 66, y: 40 };
    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: true,
      target: { x: 66, y: 40 },
    });

    surface.emit("pointerup", 66, 40);
    expect(controller.intent.held).toBe(false);
    controller.destroy();
  });

  it("ends a canceled gesture and allows the edge avatar to be grabbed again", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
      deadZonePx: 2,
      fullRangePx: 20,
    });

    surface.emit("pointerdown", 50, 40);
    surface.emit("pointermove", 180, 40);
    surface.emit("pointercancel", 180, 40);
    expect(controller.intent.held).toBe(false);
    expect(controller.phase).toBe("idle");

    surface.emit("pointerdown", 50, 40, 7, 80, 1);
    surface.emit("pointermove", 80, 40, 7, 90, 1);
    expect(controller.intent).toMatchObject({ held: true, target: { x: 80, y: 40 } });
    surface.emit("pointerup", 80, 40, 7, 100, 0);
    expect(controller.intent.held).toBe(false);
    controller.destroy();
  });

  it("tracks an active avatar drag through the owning window outside the canvas", () => {
    const surface = new WindowTrackedPointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
      deadZonePx: 2,
      fullRangePx: 20,
    });

    surface.emit("pointerdown", 50, 40);
    surface.windowTarget.emit("pointermove", -30, 75);
    expect(controller.intent).toMatchObject({
      held: true,
      target: { x: -30, y: 75 },
    });

    surface.windowTarget.emit("pointermove", 90, -25);
    expect(controller.intent).toMatchObject({
      held: true,
      target: { x: 90, y: -25 },
    });
    surface.windowTarget.emit("pointerup", 90, -25, 7, 100, 0);
    expect(controller.intent.held).toBe(false);
    controller.destroy();
  });

  it("suspends on lost capture and resumes only while the primary button remains held", () => {
    const surface = new WindowTrackedPointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
    });

    surface.emit("pointerdown", 50, 40);
    surface.emit("lostpointercapture", 60, 40, 7, 20, 1);
    expect(controller.phase).toBe("suspended");
    expect(controller.intent.held).toBe(false);

    surface.windowTarget.emit("pointermove", 90, 40, 7, 40, 1);
    expect(controller.phase).toBe("held");
    expect(controller.intent).toMatchObject({ held: true, target: { x: 90, y: 40 } });

    surface.emit("lostpointercapture", 90, 40, 7, 50, 1);
    surface.windowTarget.emit("pointermove", 90, 40, 7, 60, 0);
    expect(controller.phase).toBe("idle");
    controller.destroy();
  });

  it("detects a release missed outside the browser and permits an immediate re-grab", () => {
    const surface = new WindowTrackedPointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
    });

    surface.emit("pointerdown", 50, 40);
    surface.windowTarget.emit("pointerout", -10, 40, 7, 20, 1, {
      relatedTarget: null,
    });
    expect(controller.phase).toBe("suspended");
    surface.windowTarget.emit("pointermove", 50, 40, 7, 40, 0);
    expect(controller.phase).toBe("idle");

    surface.emit("pointerdown", 50, 40, 7, 50, 1);
    expect(controller.phase).toBe("held");
    expect(controller.intent.held).toBe(true);
    controller.destroy();
  });

  it("turns a quick avatar release into one bounded flick intent", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
      flick: {
        sampleWindowMs: 100,
        minimumSpeedPxPerSecond: 300,
        fullSpeedPxPerSecond: 1_300,
      },
    });

    surface.emit("pointerdown", 50, 40, 7, 0);
    surface.emit("pointermove", 90, 40, 7, 50);
    surface.emit("pointerup", 110, 40, 7, 75);

    expect(controller.intent).toEqual({
      direction: { x: 1, y: 0 },
      intensity: 0.5,
      held: false,
    });
    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: false,
    });
    controller.destroy();
  });

  it("stays still when an avatar drag release is below the flick threshold", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
      flick: {
        sampleWindowMs: 100,
        minimumSpeedPxPerSecond: 300,
        fullSpeedPxPerSecond: 1_300,
      },
    });

    surface.emit("pointerdown", 50, 40, 7, 0);
    surface.emit("pointermove", 55, 40, 7, 100);
    surface.emit("pointerup", 55, 40, 7, 200);

    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: false,
    });
    controller.destroy();
  });

  it("lets a consumer disable avatar flicks without disabling direct dragging", () => {
    const surface = new PointerSurface();
    const controller = new PointerDragController(surface as unknown as HTMLElement, {
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 50, y: 40 }),
      grabRadiusPx: 24,
      flick: false,
    });

    surface.emit("pointerdown", 50, 40, 7, 0);
    surface.emit("pointermove", 90, 40, 7, 25);
    expect(controller.intent.intensity).toBeGreaterThan(0);
    surface.emit("pointerup", 110, 40, 7, 50);

    expect(controller.intent).toEqual({
      direction: { x: 0, y: 0 },
      intensity: 0,
      held: false,
    });
    controller.destroy();
  });
});
