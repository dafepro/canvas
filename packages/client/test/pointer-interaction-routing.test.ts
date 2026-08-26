import { describe, expect, it } from "vitest";
import { AvatarPointerInteraction } from "../src/input/avatar-pointer-interaction.js";
import {
  ItemEditInteraction,
  type ItemEditState,
} from "../src/input/item-edit-interaction.js";
import { PointerInteractionCoordinator } from "../src/input/pointer-interaction-coordinator.js";
import type { RenderEntity } from "../src/simulation/messages.js";
import { resolvePointerSurface } from "../src/runtime/canvas-runtime.js";

class PointerSurface {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured?: number;
  readonly windowTarget?: PointerSurface;
  readonly ownerDocument?: { defaultView: Window };

  constructor(withWindow = true) {
    if (withWindow) {
      this.windowTarget = new PointerSurface(false);
      this.ownerDocument = { defaultView: this.windowTarget as unknown as Window };
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: PointerEvent) => void);
    this.listeners.set(type, listeners);
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
    return { left: 0, top: 0 } as DOMRect;
  }

  emit(type: string, x: number, y: number, buttons = type === "pointerup" ? 0 : 1): void {
    const event = {
      pointerId: 1,
      pointerType: "mouse",
      buttons,
      clientX: x,
      clientY: y,
      timeStamp: 100,
      relatedTarget: this,
      preventDefault: () => {},
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("consumer pointer surface", () => {
  it("uses the renderer by default and an aligned consumer surface when supplied", () => {
    const renderer = {} as HTMLElement;
    const consumer = {} as HTMLElement;
    expect(resolvePointerSurface(renderer)).toBe(renderer);
    expect(resolvePointerSurface(renderer, consumer)).toBe(consumer);
  });
});

const ownedItem = (): RenderEntity => ({
  id: "owned-item",
  kind: "item",
  definitionId: "box",
  ownerUserId: "alice",
  x: 20,
  y: 20,
  rotation: 0,
  scale: 1,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
});

describe("pointer interaction routing", () => {
  it("reserves an owned item over an overlapping direct avatar gesture", () => {
    const surface = new PointerSurface();
    const states: ItemEditState[] = [];
    const editor = new ItemEditInteraction({
      enabled: () => true,
      pick: () => ownedItem(),
      onPreview: () => {},
      onCommit: () => {},
      onChange: (state) => states.push(state),
    });
    const avatar = new AvatarPointerInteraction({
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 20, y: 20 }),
      grabRadiusPx: 30,
    });
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      {
        strategies: [avatar, editor],
        toWorld: (point) => ({ ...point }),
      },
    );

    surface.emit("pointerdown", 20, 20);
    expect(coordinator.diagnostics).toMatchObject({
      phase: "pending",
      strategyId: "item-edit",
      kind: "item-select",
    });
    surface.windowTarget!.emit("pointermove", 40, 20);
    surface.windowTarget!.emit("pointerup", 40, 20);

    expect(states).toEqual([]);
    expect(avatar.intent).toMatchObject({ held: false, intensity: 0 });
    coordinator.destroy();
  });

  it("selects on tap, then previews and commits only a later selected-item drag", () => {
    const surface = new PointerSurface();
    const states: ItemEditState[] = [];
    const previews: number[] = [];
    const commits: number[] = [];
    const editor = new ItemEditInteraction({
      enabled: () => true,
      pick: () => ownedItem(),
      onPreview: (_id, transform) => previews.push(transform.x),
      onCommit: (_id, transform) => commits.push(transform.x),
      onChange: (state) => states.push(state),
    });
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [editor], toWorld: (point) => ({ ...point }) },
    );

    surface.emit("pointerdown", 20, 20);
    surface.windowTarget!.emit("pointerup", 20, 20);
    expect(states.at(-1)?.selectedEntityId).toBe("owned-item");

    surface.emit("pointerdown", 20, 20);
    surface.windowTarget!.emit("pointermove", 30, 20);
    expect(coordinator.diagnostics.phase).toBe("active");
    surface.windowTarget!.emit("pointerup", 30, 20);

    expect(previews).toEqual([30]);
    expect(commits).toEqual([30]);
    coordinator.destroy();
  });

  it("lets avatar movement claim a non-item point while clearing edit selection", () => {
    const surface = new PointerSurface();
    const selections: Array<string | undefined> = [];
    let hitsItem = true;
    const editor = new ItemEditInteraction({
      enabled: () => true,
      pick: () => hitsItem ? ownedItem() : undefined,
      onPreview: () => {},
      onCommit: () => {},
      onChange: (state) => selections.push(state.selectedEntityId),
    });
    editor.select(ownedItem());
    hitsItem = false;
    const avatar = new AvatarPointerInteraction({
      mode: "avatarDrag",
      avatarPosition: () => ({ x: 20, y: 20 }),
      grabRadiusPx: 30,
    });
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [editor, avatar], toWorld: (point) => ({ ...point }) },
    );

    surface.emit("pointerdown", 20, 20);

    expect(selections.at(-1)).toBeUndefined();
    expect(coordinator.diagnostics.strategyId).toBe("avatar-movement");
    coordinator.destroy();
  });

  it("cancels an in-progress edit without committing when editing is disabled", () => {
    const surface = new PointerSurface();
    const states: ItemEditState[] = [];
    const commits: number[] = [];
    const editor = new ItemEditInteraction({
      enabled: () => true,
      pick: () => ownedItem(),
      onPreview: () => {},
      onCommit: (_id, transform) => commits.push(transform.x),
      onChange: (state) => states.push(state),
    });
    editor.select(ownedItem());
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      { strategies: [editor], toWorld: (point) => ({ ...point }) },
    );
    surface.emit("pointerdown", 20, 20);
    surface.windowTarget!.emit("pointermove", 30, 20);

    coordinator.cancel("strategy_disabled");
    surface.windowTarget!.emit("pointerup", 30, 20);

    expect(commits).toEqual([]);
    expect(states.at(-1)).toEqual({ selectedEntityId: "owned-item", ghost: undefined });
    expect(coordinator.diagnostics.lastTerminalReason).toBe("strategy_disabled");
    coordinator.destroy();
  });

  it("lets a higher-priority consumer strategy override built-ins", () => {
    const surface = new PointerSurface();
    const avatar = new AvatarPointerInteraction();
    const coordinator = new PointerInteractionCoordinator(
      surface as unknown as HTMLElement,
      {
        strategies: [
          avatar,
          {
            id: "consumer-lasso",
            priority: 300,
            claim: () => ({ kind: "lasso", release: () => {}, cancel: () => {} }),
          },
        ],
      },
    );

    surface.emit("pointerdown", 5, 5);

    expect(coordinator.diagnostics).toMatchObject({
      strategyId: "consumer-lasso",
      kind: "lasso",
    });
    expect(avatar.intent.held).toBe(false);
    coordinator.destroy();
  });
});
