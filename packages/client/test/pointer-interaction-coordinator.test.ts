import { describe, expect, it } from "vitest";
import {
  PointerInteractionCoordinator,
  type PointerInteractionClaim,
  type PointerInteractionStrategy,
  type PointerInteractionTerminalReason,
} from "../src/input/pointer-interaction-coordinator.js";

class PointerSurface {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured?: number;
  readonly windowTarget?: PointerSurface;
  readonly ownerDocument?: { defaultView: Window };

  constructor(withWindow = false) {
    if (withWindow) {
      this.windowTarget = new PointerSurface();
      this.ownerDocument = { defaultView: this.windowTarget as unknown as Window };
    }
  }

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
    buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1,
    init: Partial<PointerEvent> = {},
  ): void {
    const event = {
      pointerId,
      pointerType: "mouse",
      buttons,
      clientX: x + 10,
      clientY: y + 20,
      timeStamp: 100,
      relatedTarget: this,
      preventDefault: () => {},
      ...init,
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  loseCapture(pointerId = 7): void {
    this.captured = undefined;
    this.emit("lostpointercapture", 0, 0, pointerId, 1);
  }
}

const strategy = (
  id: string,
  priority: number,
  claim: (events: string[]) => PointerInteractionClaim,
  events: string[],
): PointerInteractionStrategy => ({
  id,
  priority,
  claim: () => claim(events),
});

const recordingClaim = (events: string[]): PointerInteractionClaim => ({
  kind: "recording",
  move: ({ local }) => events.push(`move:${local.x},${local.y}`),
  release: () => events.push("release"),
  cancel: (reason) => events.push(`cancel:${reason}`),
  suspend: () => events.push("suspend"),
  resume: ({ local }) => events.push(`resume:${local.x},${local.y}`),
});

describe("PointerInteractionCoordinator", () => {
  it("gives one pointer to the highest-priority claimant and terminates it once", () => {
    const surface = new PointerSurface(true);
    const events: string[] = [];
    let lowerClaims = 0;
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      {
        strategies: [
          {
            id: "lower",
            priority: 10,
            claim: () => {
              lowerClaims++;
              return recordingClaim(events);
            },
          },
          strategy("higher", 20, recordingClaim, events),
        ],
      },
    );

    surface.emit("pointerdown", 20, 30);
    surface.windowTarget!.emit("pointermove", 24, 36);
    surface.windowTarget!.emit("pointerup", 24, 36);
    // Browsers may emit lostpointercapture after releasePointerCapture. It is
    // not a second terminal event.
    surface.emit("lostpointercapture", 24, 36);

    expect(lowerClaims).toBe(0);
    expect(events).toEqual(["move:24,36", "release"]);
    expect(coordinator.diagnostics).toMatchObject({
      phase: "idle",
      lastStrategyId: "higher",
      lastTerminalReason: "released",
    });
    coordinator.destroy();
  });

  it("normalizes local and world points without exposing the DOM event", () => {
    const surface = new PointerSurface();
    const samples: Array<{ local: { x: number; y: number }; world?: { x: number; y: number } }> = [];
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      {
        toWorld: ({ x, y }) => ({ x: x / 2, y: y / 4 }),
        strategies: [{
          id: "consumer",
          priority: 1,
          claim: (sample) => {
            samples.push(sample);
            return {
              move: (next) => samples.push(next),
              release: () => {},
              cancel: () => {},
            };
          },
        }],
      },
    );

    surface.emit("pointerdown", 40, 20);
    surface.emit("pointermove", 60, 36);

    expect(samples).toEqual([
      { ...samples[0], local: { x: 40, y: 20 }, world: { x: 20, y: 5 } },
      { ...samples[1], local: { x: 60, y: 36 }, world: { x: 30, y: 9 } },
    ]);
    coordinator.destroy();
  });

  it("suspends on capture loss and resumes a held primary pointer", () => {
    const surface = new PointerSurface(true);
    const events: string[] = [];
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [strategy("avatar", 1, recordingClaim, events)] },
    );

    surface.emit("pointerdown", 50, 40);
    surface.loseCapture();
    expect(coordinator.diagnostics.phase).toBe("suspended");
    surface.windowTarget!.emit("pointermove", 80, 44, 7, 1);
    surface.windowTarget!.emit("pointerup", 80, 44);

    expect(events).toEqual(["suspend", "resume:80,44", "release"]);
    expect(coordinator.diagnostics.suspensions).toBe(1);
    coordinator.destroy();
  });

  it("ends a missed release as button_lost and permits immediate re-grab", () => {
    const surface = new PointerSurface(true);
    const events: string[] = [];
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [strategy("avatar", 1, recordingClaim, events)] },
    );

    surface.emit("pointerdown", 50, 40);
    surface.windowTarget!.emit("pointerout", -10, 40, 7, 1, { relatedTarget: null });
    surface.windowTarget!.emit("pointermove", 50, 40, 7, 0);
    surface.emit("pointerdown", 50, 40, 7, 1);
    surface.windowTarget!.emit("pointerup", 50, 40);

    expect(events).toEqual([
      "suspend",
      "cancel:button_lost",
      "release",
    ]);
    coordinator.destroy();
  });

  it("ignores secondary pointers until the active pointer terminates", () => {
    const surface = new PointerSurface(true);
    const events: string[] = [];
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [strategy("one-at-a-time", 1, recordingClaim, events)] },
    );

    surface.emit("pointerdown", 10, 10, 1);
    surface.emit("pointerdown", 20, 20, 2);
    surface.windowTarget!.emit("pointermove", 30, 30, 2);
    surface.windowTarget!.emit("pointerup", 10, 10, 1);

    expect(events).toEqual(["release"]);
    expect(coordinator.diagnostics.ignoredPointers).toBe(1);
    coordinator.destroy();
  });

  it.each([
    ["pointercancel", "cancelled"],
    ["manual", "strategy_disabled"],
    ["destroy", "destroyed"],
  ] as const)("delivers exactly one terminal callback for %s", (action, reason) => {
    const surface = new PointerSurface(true);
    const terminals: PointerInteractionTerminalReason[] = [];
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      {
        strategies: [{
          id: "terminal",
          priority: 1,
          claim: () => ({
            release: () => terminals.push("released"),
            cancel: (terminal) => terminals.push(terminal),
          }),
        }],
      },
    );
    surface.emit("pointerdown", 10, 10);

    if (action === "pointercancel") surface.windowTarget!.emit("pointercancel", 10, 10);
    if (action === "manual") coordinator.cancel("strategy_disabled");
    if (action === "destroy") coordinator.destroy();
    surface.emit("lostpointercapture", 10, 10);
    surface.windowTarget!.emit("pointerup", 10, 10);

    expect(terminals).toEqual([reason]);
    coordinator.destroy();
  });
});
