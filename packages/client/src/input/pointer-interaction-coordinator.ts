import type { Vec2 } from "@canvas-physics/core";

export type PointerInteractionPhase = "idle" | "pending" | "active" | "suspended";

export type PointerInteractionTerminalReason =
  | "released"
  | "cancelled"
  | "button_lost"
  | "superseded"
  | "strategy_removed"
  | "strategy_disabled"
  | "selection_changed"
  | "avatar_disabled"
  | "destroyed";

/** Immutable pointer data normalized by Canvas before an interaction sees it. */
export interface PointerInteractionSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly buttons: number;
  readonly timeStamp: number;
  readonly client: Readonly<Vec2>;
  readonly local: Readonly<Vec2>;
  readonly world?: Readonly<Vec2>;
}

/**
 * One exclusive claim created on pointer-down. The coordinator owns DOM
 * capture and terminal delivery; a claim owns only feature-local meaning.
 */
export interface PointerInteractionClaim {
  readonly kind?: string;
  /** Lets tap/drag recognizers expose pending state without owning DOM events. */
  readonly phase?: () => "pending" | "active";
  move?(sample: Readonly<PointerInteractionSample>): void;
  release?(sample: Readonly<PointerInteractionSample>): void;
  cancel?(
    reason: Exclude<PointerInteractionTerminalReason, "released">,
    sample?: Readonly<PointerInteractionSample>,
  ): void;
  suspend?(): void;
  resume?(sample: Readonly<PointerInteractionSample>): void;
}

/** Highest priority claimant wins. Equal priorities retain registration order. */
export interface PointerInteractionStrategy {
  readonly id: string;
  readonly priority: number;
  claim(
    sample: Readonly<PointerInteractionSample>,
  ): PointerInteractionClaim | undefined;
}

export interface PointerInteractionCoordinatorOptions {
  readonly strategies: readonly PointerInteractionStrategy[];
  readonly toWorld?: (local: Readonly<Vec2>) => Vec2 | undefined;
  readonly onError?: (error: Error, strategyId: string) => void;
}

export interface PointerInteractionDiagnostics {
  readonly phase: PointerInteractionPhase;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly strategyId?: string;
  readonly kind?: string;
  readonly point?: Readonly<Vec2>;
  readonly worldPoint?: Readonly<Vec2>;
  readonly captured: boolean;
  readonly suspensions: number;
  readonly ignoredPointers: number;
  readonly lastStrategyId?: string;
  readonly lastTerminalReason?: PointerInteractionTerminalReason;
}

/** Stable built-in ordering points for consumer strategies. */
export const pointerInteractionPriorities = Object.freeze({
  avatarMovement: 100,
  itemEdit: 200,
});

interface ActiveInteraction {
  pointerId: number;
  pointerType: string;
  strategyId: string;
  claim: PointerInteractionClaim;
  sample: Readonly<PointerInteractionSample>;
  suspended: boolean;
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * The only owner of pointer listeners and capture for one Canvas runtime.
 * Features compete synchronously on pointer-down, after which exactly one
 * claim receives one terminal release/cancel transition.
 */
export class PointerInteractionCoordinator {
  private readonly strategies: readonly PointerInteractionStrategy[];
  private readonly dragTarget: EventTarget;
  private readonly detach: () => void;
  private active?: ActiveInteraction;
  private suspensions = 0;
  private ignoredPointers = 0;
  private lastStrategyId?: string;
  private lastTerminalReason?: PointerInteractionTerminalReason;
  private destroyed = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly options: PointerInteractionCoordinatorOptions,
  ) {
    const strategyIds = new Set<string>();
    for (const strategy of options.strategies) {
      if (!strategy.id.trim()) throw new Error("pointer interaction strategy id is required");
      if (strategyIds.has(strategy.id)) {
        throw new Error(`duplicate pointer interaction strategy '${strategy.id}'`);
      }
      if (!Number.isFinite(strategy.priority)) {
        throw new Error(`pointer interaction strategy '${strategy.id}' has invalid priority`);
      }
      strategyIds.add(strategy.id);
    }
    this.strategies = options.strategies
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) =>
        right.entry.priority - left.entry.priority || left.index - right.index)
      .map(({ entry }) => entry);
    this.dragTarget = this.element.ownerDocument?.defaultView ?? this.element;

    const onDown = (event: PointerEvent) => {
      if (this.destroyed) return;
      if (this.active) {
        if (this.active.suspended) {
          this.terminateCancel("superseded", this.sample(event));
        } else {
          this.ignoredPointers++;
          return;
        }
      }
      const sample = this.sample(event);
      for (const strategy of this.strategies) {
        let claim: PointerInteractionClaim | undefined;
        try {
          claim = strategy.claim(sample);
        } catch (cause) {
          this.report(cause, strategy.id);
          continue;
        }
        if (!claim) continue;
        event.preventDefault();
        this.active = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          strategyId: strategy.id,
          claim,
          sample,
          suspended: false,
        };
        this.capture(event.pointerId);
        return;
      }
    };

    const onMove = (event: PointerEvent) => {
      const active = this.active;
      if (!active || event.pointerId !== active.pointerId) return;
      const sample = this.sample(event);
      if (!this.primaryHeld(event)) {
        this.terminateCancel("button_lost", sample);
        return;
      }
      event.preventDefault();
      active.sample = sample;
      if (active.suspended) {
        active.suspended = false;
        this.capture(event.pointerId);
        this.invoke(active, "resume", sample);
        return;
      }
      this.invoke(active, "move", sample);
    };

    const onUp = (event: PointerEvent) => {
      if (!this.active || event.pointerId !== this.active.pointerId) return;
      event.preventDefault();
      this.terminateRelease(this.sample(event));
    };

    const onCancel = (event: PointerEvent) => {
      if (!this.active || event.pointerId !== this.active.pointerId) return;
      event.preventDefault();
      this.terminateCancel("cancelled", this.sample(event));
    };

    const onLostCapture = (event: PointerEvent) => {
      if (this.active?.pointerId === event.pointerId) this.suspend();
    };

    const onWindowExit = (event: PointerEvent) => {
      if (
        this.active?.pointerId === event.pointerId &&
        event.relatedTarget === null
      ) {
        this.suspend();
      }
    };

    const onBlur = () => this.suspend();

    this.element.addEventListener("pointerdown", onDown);
    this.dragTarget.addEventListener("pointermove", onMove as EventListener);
    this.dragTarget.addEventListener("pointerup", onUp as EventListener);
    this.dragTarget.addEventListener("pointercancel", onCancel as EventListener);
    this.dragTarget.addEventListener("pointerout", onWindowExit as EventListener);
    this.dragTarget.addEventListener("blur", onBlur as EventListener);
    this.element.addEventListener("lostpointercapture", onLostCapture);
    this.detach = () => {
      this.element.removeEventListener("pointerdown", onDown);
      this.dragTarget.removeEventListener("pointermove", onMove as EventListener);
      this.dragTarget.removeEventListener("pointerup", onUp as EventListener);
      this.dragTarget.removeEventListener("pointercancel", onCancel as EventListener);
      this.dragTarget.removeEventListener("pointerout", onWindowExit as EventListener);
      this.dragTarget.removeEventListener("blur", onBlur as EventListener);
      this.element.removeEventListener("lostpointercapture", onLostCapture);
    };
  }

  get diagnostics(): Readonly<PointerInteractionDiagnostics> {
    const active = this.active;
    const pending = active?.claim.phase?.() === "pending";
    return Object.freeze({
      phase: active
        ? active.suspended
          ? "suspended"
          : pending
            ? "pending"
            : "active"
        : "idle",
      pointerId: active?.pointerId,
      pointerType: active?.pointerType,
      strategyId: active?.strategyId,
      kind: active?.claim.kind,
      point: active ? Object.freeze({ ...active.sample.local }) : undefined,
      worldPoint: active?.sample.world
        ? Object.freeze({ ...active.sample.world })
        : undefined,
      captured: active !== undefined && this.element.hasPointerCapture(active.pointerId),
      suspensions: this.suspensions,
      ignoredPointers: this.ignoredPointers,
      lastStrategyId: this.lastStrategyId,
      lastTerminalReason: this.lastTerminalReason,
    });
  }

  /** Cancels the current claim for a runtime-owned state transition. */
  cancel(
    reason: Exclude<PointerInteractionTerminalReason, "released" | "cancelled" | "button_lost" | "superseded" | "destroyed">,
  ): void {
    this.terminateCancel(reason);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.terminateCancel("destroyed");
    this.detach();
  }

  private sample(event: PointerEvent): Readonly<PointerInteractionSample> {
    const rect = this.element.getBoundingClientRect();
    const local = Object.freeze({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    const world = this.options.toWorld?.(local);
    return Object.freeze({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      buttons: event.buttons,
      timeStamp: event.timeStamp,
      client: Object.freeze({ x: event.clientX, y: event.clientY }),
      local,
      world: world ? Object.freeze({ ...world }) : undefined,
    });
  }

  private primaryHeld(event: PointerEvent): boolean {
    return event.pointerType === "touch" || (event.buttons & 1) !== 0;
  }

  private capture(pointerId: number): void {
    try {
      this.element.setPointerCapture(pointerId);
    } catch {
      // Window tracking remains authoritative if capture is unavailable.
    }
  }

  private suspend(): void {
    const active = this.active;
    if (!active || active.suspended) return;
    active.suspended = true;
    this.suspensions++;
    this.invoke(active, "suspend");
  }

  private terminateRelease(sample: Readonly<PointerInteractionSample>): void {
    const active = this.takeActive("released");
    if (!active) return;
    this.invoke(active, "release", sample);
    this.releaseCapture(active.pointerId);
  }

  private terminateCancel(
    reason: Exclude<PointerInteractionTerminalReason, "released">,
    sample?: Readonly<PointerInteractionSample>,
  ): void {
    const active = this.takeActive(reason);
    if (!active) return;
    try {
      active.claim.cancel?.(reason, sample);
    } catch (cause) {
      this.report(cause, active.strategyId);
    }
    this.releaseCapture(active.pointerId);
  }

  private takeActive(reason: PointerInteractionTerminalReason): ActiveInteraction | undefined {
    const active = this.active;
    if (!active) return undefined;
    this.active = undefined;
    this.lastStrategyId = active.strategyId;
    this.lastTerminalReason = reason;
    return active;
  }

  private releaseCapture(pointerId: number): void {
    if (!this.element.hasPointerCapture(pointerId)) return;
    try {
      this.element.releasePointerCapture(pointerId);
    } catch {
      // The browser already released it; the claim is terminal either way.
    }
  }

  private invoke(
    active: ActiveInteraction,
    method: "move" | "release" | "suspend" | "resume",
    sample?: Readonly<PointerInteractionSample>,
  ): void {
    try {
      if (method === "suspend") active.claim.suspend?.();
      else if (sample) active.claim[method]?.(sample);
    } catch (cause) {
      this.report(cause, active.strategyId);
    }
  }

  private report(cause: unknown, strategyId: string): void {
    try {
      this.options.onError?.(asError(cause), strategyId);
    } catch {
      // Consumer error reporting cannot corrupt pointer ownership.
    }
  }
}
