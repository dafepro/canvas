import type { Vec2 } from "@canvas-physics/core";

export interface DragIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
  /** Direct-drag target in element pixels. CanvasRuntime converts it to world units. */
  target?: Vec2;
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

export interface PointerFlickOptions {
  /** Recent pointer history used to estimate release speed. */
  sampleWindowMs?: number;
  /** Slower releases stop normally instead of imparting momentum. */
  minimumSpeedPxPerSecond?: number;
  /** Release speed that maps to the canvas avatar's full movement speed. */
  fullSpeedPxPerSecond?: number;
}

export const defaultPointerFlickOptions: Required<PointerFlickOptions> = {
  sampleWindowMs: 100,
  minimumSpeedPxPerSecond: 300,
  fullSpeedPxPerSecond: 1_300,
};

export interface PointerDragOptions {
  /** Relative thumbstick by default, or direct positioning under the pointer. */
  mode?: "thumbstick" | "avatarDrag";
  /** Drag distance in pixels that maps to full intensity. */
  fullRangePx?: number;
  /** Dead zone in pixels. */
  deadZonePx?: number;
  /** Touch radius around the avatar in avatarDrag mode. */
  grabRadiusPx?: number;
  /** Current local-avatar position in element pixels. Required by avatarDrag. */
  avatarPosition?: () => Vec2 | undefined;
  /** Avatar-drag release momentum. Enabled by default; pass false to disable it. */
  flick?: false | PointerFlickOptions;
  /** Lets a live editor reserve pointer-down locations without disabling movement. */
  allowStart?: (point: Readonly<Vec2>) => boolean;
}

/**
 * Spec 6.1. Thumbstick mode emits relative movement. Avatar-drag mode emits an
 * absolute target that host simulation reaches without a speed cap while its
 * full-path shape sweep still prevents tunneling through solid geometry.
 */
export class PointerDragController {
  private activePointerId?: number;
  private interruptedPointerId?: number;
  private origin?: { x: number; y: number };
  private originLocal?: Vec2;
  private pointLocal?: Vec2;
  private samples: { point: Vec2; atMs: number }[] = [];
  private releaseIntent?: DragIntent;
  private current: DragIntent = { direction: { x: 0, y: 0 }, intensity: 0, held: false };
  private readonly mode: "thumbstick" | "avatarDrag";
  private readonly fullRangePx: number;
  private readonly deadZonePx: number;
  private readonly grabRadiusPx: number;
  private readonly avatarPosition?: () => Vec2 | undefined;
  private readonly flick?: Required<PointerFlickOptions>;
  private readonly allowStart?: (point: Readonly<Vec2>) => boolean;
  private readonly detach: () => void;

  constructor(
    private readonly element: HTMLElement,
    options: PointerDragOptions = {},
  ) {
    this.mode = options.mode ?? "thumbstick";
    this.fullRangePx = options.fullRangePx ?? 90;
    this.deadZonePx = options.deadZonePx ?? 6;
    this.grabRadiusPx = options.grabRadiusPx ?? 32;
    this.avatarPosition = options.avatarPosition;
    this.flick = options.flick === false
      ? undefined
      : { ...defaultPointerFlickOptions, ...options.flick };
    this.allowStart = options.allowStart;

    const onDown = (event: PointerEvent) => {
      if (this.activePointerId !== undefined) return;
      this.interruptedPointerId = undefined;
      const point = this.toLocal(event);
      if (this.allowStart?.(point) === false) return;
      if (this.mode === "avatarDrag") {
        const avatar = this.avatarPosition?.();
        if (
          !avatar ||
          Math.hypot(point.x - avatar.x, point.y - avatar.y) > this.grabRadiusPx
        ) {
          return;
        }
      }
      event.preventDefault();
      this.element.setPointerCapture(event.pointerId);
      this.activePointerId = event.pointerId;
      this.origin = { x: event.clientX, y: event.clientY };
      this.originLocal = point;
      this.pointLocal = { ...this.originLocal };
      this.samples = [{ point: { ...point }, atMs: event.timeStamp }];
      this.releaseIntent = undefined;
      this.current = this.mode === "avatarDrag"
        ? { direction: { x: 0, y: 0 }, intensity: 0, held: true, target: { ...point } }
        : { direction: { x: 0, y: 0 }, intensity: 0, held: true };
    };
    const onMove = (event: PointerEvent) => {
      if (
        this.activePointerId === undefined &&
        this.interruptedPointerId === event.pointerId
      ) {
        if ((event.buttons & 1) === 0) {
          this.interruptedPointerId = undefined;
          return;
        }
        event.preventDefault();
        this.activePointerId = event.pointerId;
        this.interruptedPointerId = undefined;
        this.origin = { x: event.clientX, y: event.clientY };
        this.originLocal = this.toLocal(event);
        this.pointLocal = { ...this.originLocal };
        this.samples = [{ point: { ...this.pointLocal }, atMs: event.timeStamp }];
        this.releaseIntent = undefined;
        this.current = {
          direction: { x: 0, y: 0 },
          intensity: 0,
          held: true,
          target: { ...this.pointLocal },
        };
        try {
          this.element.setPointerCapture(event.pointerId);
        } catch {
          // Some browsers resume moves before they allow capture again.
        }
        this.updateAvatarDragIntent();
        return;
      }
      if (event.pointerId !== this.activePointerId || !this.origin) return;
      event.preventDefault();
      this.pointLocal = this.toLocal(event);
      if (this.mode === "avatarDrag") {
        this.rememberSample(this.pointLocal, event.timeStamp);
        this.updateAvatarDragIntent();
        return;
      }
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
      if (event.pointerId !== this.activePointerId) {
        if (event.pointerId === this.interruptedPointerId) {
          this.interruptedPointerId = undefined;
        }
        return;
      }
      if (this.mode === "avatarDrag") {
        this.rememberSample(this.toLocal(event), event.timeStamp);
        this.releaseIntent = this.flickIntent();
      }
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.activePointerId = undefined;
      this.origin = undefined;
      this.originLocal = undefined;
      this.pointLocal = undefined;
      this.samples = [];
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: false };
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== this.activePointerId) return;
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.interruptedPointerId = this.mode === "avatarDrag" ? event.pointerId : undefined;
      this.activePointerId = undefined;
      this.origin = undefined;
      this.originLocal = undefined;
      this.pointLocal = undefined;
      this.samples = [];
      this.releaseIntent = undefined;
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: false };
    };

    // Pointer capture is useful but not sufficient on every mobile/browser
    // combination. Track active moves on the owning window so leaving the
    // canvas still updates the nearest reachable world-edge target.
    const dragTarget: EventTarget = this.element.ownerDocument?.defaultView ?? this.element;
    this.element.addEventListener("pointerdown", onDown);
    dragTarget.addEventListener("pointermove", onMove as EventListener);
    dragTarget.addEventListener("pointerup", onUp as EventListener);
    dragTarget.addEventListener("pointercancel", onCancel as EventListener);
    this.detach = () => {
      this.element.removeEventListener("pointerdown", onDown);
      dragTarget.removeEventListener("pointermove", onMove as EventListener);
      dragTarget.removeEventListener("pointerup", onUp as EventListener);
      dragTarget.removeEventListener("pointercancel", onCancel as EventListener);
    };
  }

  get intent(): DragIntent {
    if (this.releaseIntent) {
      const intent = this.releaseIntent;
      this.releaseIntent = undefined;
      return intent;
    }
    if (this.mode === "avatarDrag" && this.current.held) {
      this.updateAvatarDragIntent();
    }
    return this.current;
  }

  /**
   * Spec 6.1. The overlay shows the centre of the drag and its direction, so the
   * player can see what the gesture means.
   */
  get gesture(): DragGesture | undefined {
    if (this.mode !== "thumbstick" || !this.originLocal || !this.pointLocal) {
      return undefined;
    }
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

  private updateAvatarDragIntent(): void {
    const avatar = this.avatarPosition?.();
    if (!avatar || !this.pointLocal) {
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: true };
      return;
    }
    const target = { ...this.pointLocal };
    const dx = target.x - avatar.x;
    const dy = target.y - avatar.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= this.deadZonePx) {
      this.current = {
        direction: { x: 0, y: 0 },
        intensity: 0,
        held: true,
        target,
      };
      return;
    }
    this.current = {
      direction: { x: dx / distance, y: dy / distance },
      intensity: Math.min(1, (distance - this.deadZonePx) / this.fullRangePx),
      held: true,
      target,
    };
  }

  private rememberSample(point: Readonly<Vec2>, atMs: number): void {
    this.samples.push({ point: { ...point }, atMs });
    const cutoff = atMs - (this.flick?.sampleWindowMs ?? 0);
    this.samples = this.samples.filter((sample) => sample.atMs >= cutoff);
  }

  private flickIntent(): DragIntent | undefined {
    const config = this.flick;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!config || !first || !last || last.atMs <= first.atMs) return undefined;
    const elapsedSeconds = (last.atMs - first.atMs) / 1_000;
    const dx = last.point.x - first.point.x;
    const dy = last.point.y - first.point.y;
    const distance = Math.hypot(dx, dy);
    const speed = distance / elapsedSeconds;
    if (distance === 0 || speed <= config.minimumSpeedPxPerSecond) return undefined;
    const range = Math.max(
      1,
      config.fullSpeedPxPerSecond - config.minimumSpeedPxPerSecond,
    );
    return {
      direction: { x: dx / distance, y: dy / distance },
      intensity: Math.min(1, (speed - config.minimumSpeedPxPerSecond) / range),
      held: false,
    };
  }

  destroy(): void {
    this.interruptedPointerId = undefined;
    this.releaseIntent = undefined;
    this.samples = [];
    this.detach();
  }
}
