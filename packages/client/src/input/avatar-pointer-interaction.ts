import type { Vec2 } from "@canvas-physics/core";
import type {
  PointerInteractionClaim,
  PointerInteractionSample,
  PointerInteractionStrategy,
} from "./pointer-interaction-coordinator.js";

export interface AvatarPointerIntent {
  direction: Vec2;
  intensity: number;
  held: boolean;
  /** Direct-drag target in element pixels. CanvasRuntime converts it to world units. */
  target?: Vec2;
}

/** The on-screen state of a relative thumbstick gesture. */
export interface AvatarPointerGesture {
  origin: Vec2;
  point: Vec2;
  rangePx: number;
  intensity: number;
}

export interface PointerFlickOptions {
  sampleWindowMs?: number;
  minimumSpeedPxPerSecond?: number;
  fullSpeedPxPerSecond?: number;
}

export const defaultPointerFlickOptions: Required<PointerFlickOptions> = {
  sampleWindowMs: 100,
  minimumSpeedPxPerSecond: 300,
  fullSpeedPxPerSecond: 1_300,
};

export interface AvatarPointerOptions {
  /** Relative thumbstick by default, or direct positioning under the pointer. */
  mode?: "thumbstick" | "avatarDrag";
  fullRangePx?: number;
  deadZonePx?: number;
  grabRadiusPx?: number;
  /** Current local-avatar position in element pixels. Required by avatarDrag. */
  avatarPosition?: () => Vec2 | undefined;
  /** Avatar-drag release momentum. Enabled by default; pass false to disable it. */
  flick?: false | PointerFlickOptions;
}

interface PointerSampleRecord {
  point: Vec2;
  atMs: number;
}

const STILL: AvatarPointerIntent = {
  direction: { x: 0, y: 0 },
  intensity: 0,
  held: false,
};

/**
 * Pure avatar gesture meaning. Pointer capture, browser lifecycle, and
 * terminal ownership belong exclusively to PointerInteractionCoordinator.
 */
export class AvatarPointerInteraction implements PointerInteractionStrategy {
  readonly id = "avatar-movement";
  readonly priority = 100;

  private readonly mode: "thumbstick" | "avatarDrag";
  private readonly fullRangePx: number;
  private readonly deadZonePx: number;
  private readonly grabRadiusPx: number;
  private readonly avatarPosition?: () => Vec2 | undefined;
  private readonly flick?: Required<PointerFlickOptions>;
  private originClient?: Vec2;
  private originLocal?: Vec2;
  private pointLocal?: Vec2;
  private samples: PointerSampleRecord[] = [];
  private releaseIntent?: AvatarPointerIntent;
  private current: AvatarPointerIntent = STILL;

  constructor(options: AvatarPointerOptions = {}) {
    this.mode = options.mode ?? "thumbstick";
    this.fullRangePx = options.fullRangePx ?? 90;
    this.deadZonePx = options.deadZonePx ?? 6;
    this.grabRadiusPx = options.grabRadiusPx ?? 32;
    this.avatarPosition = options.avatarPosition;
    this.flick = options.flick === false
      ? undefined
      : { ...defaultPointerFlickOptions, ...options.flick };
  }

  claim(sample: Readonly<PointerInteractionSample>): PointerInteractionClaim | undefined {
    if (this.mode === "avatarDrag") {
      const avatar = this.avatarPosition?.();
      if (
        !avatar ||
        Math.hypot(sample.local.x - avatar.x, sample.local.y - avatar.y) > this.grabRadiusPx
      ) {
        return undefined;
      }
    }

    this.begin(sample);
    return {
      kind: this.mode === "avatarDrag" ? "avatar-drag" : "thumbstick",
      move: (next) => this.move(next),
      release: (next) => this.release(next),
      cancel: () => this.reset(),
      suspend: () => this.suspend(),
      resume: (next) => this.resume(next),
    };
  }

  get intent(): AvatarPointerIntent {
    if (this.releaseIntent) {
      const intent = this.releaseIntent;
      this.releaseIntent = undefined;
      return intent;
    }
    if (this.mode === "avatarDrag" && this.current.held) this.updateDirectIntent();
    return this.current;
  }

  get gesture(): AvatarPointerGesture | undefined {
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

  reset(): void {
    this.originClient = undefined;
    this.originLocal = undefined;
    this.pointLocal = undefined;
    this.samples = [];
    this.releaseIntent = undefined;
    this.current = STILL;
  }

  private begin(sample: Readonly<PointerInteractionSample>): void {
    this.originClient = { ...sample.client };
    this.originLocal = { ...sample.local };
    this.pointLocal = { ...sample.local };
    this.samples = [{ point: { ...sample.local }, atMs: sample.timeStamp }];
    this.releaseIntent = undefined;
    this.current = this.mode === "avatarDrag"
      ? {
          direction: { x: 0, y: 0 },
          intensity: 0,
          held: true,
          target: { ...sample.local },
        }
      : { direction: { x: 0, y: 0 }, intensity: 0, held: true };
  }

  private move(sample: Readonly<PointerInteractionSample>): void {
    if (!this.originClient) return;
    this.pointLocal = { ...sample.local };
    if (this.mode === "avatarDrag") {
      this.rememberSample(sample.local, sample.timeStamp);
      this.updateDirectIntent();
      return;
    }
    const dx = sample.client.x - this.originClient.x;
    const dy = sample.client.y - this.originClient.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= this.deadZonePx) {
      this.current = { direction: { x: 0, y: 0 }, intensity: 0, held: true };
      return;
    }
    this.current = {
      direction: { x: dx / distance, y: dy / distance },
      intensity: Math.min(1, (distance - this.deadZonePx) / this.fullRangePx),
      held: true,
    };
  }

  private release(sample: Readonly<PointerInteractionSample>): void {
    if (this.mode === "avatarDrag") {
      this.rememberSample(sample.local, sample.timeStamp);
      this.releaseIntent = this.flickIntent();
    }
    this.originClient = undefined;
    this.originLocal = undefined;
    this.pointLocal = undefined;
    this.samples = [];
    this.current = STILL;
  }

  private suspend(): void {
    this.samples = [];
    this.releaseIntent = undefined;
    this.current = STILL;
  }

  private resume(sample: Readonly<PointerInteractionSample>): void {
    this.begin(sample);
    if (this.mode === "avatarDrag") this.updateDirectIntent();
  }

  private updateDirectIntent(): void {
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

  private flickIntent(): AvatarPointerIntent | undefined {
    const config = this.flick;
    const first = this.samples[0];
    const last = this.samples.at(-1);
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
}
