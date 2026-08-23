import { describe, expect, it } from "vitest";
import type { ItemDefinition } from "@canvas-physics/core";
import {
  ItemEditController,
  findOwnedItemAt,
} from "../src/input/item-edit-controller.js";
import type { RenderEntity } from "../src/simulation/messages.js";

class PointerSurface {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured?: number;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const handler = listener as (event: PointerEvent) => void;
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
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

  emit(type: string, x: number, y: number): void {
    const event = {
      pointerId: 7,
      clientX: x + 10,
      clientY: y + 20,
      preventDefault: () => {},
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const definition = {
  definitionId: "crate",
  visual: { size: { width: 4, height: 2 } },
} as ItemDefinition;

const item = (ownerUserId = "alice"): RenderEntity => ({
  id: "item-1",
  kind: "item",
  definitionId: "crate",
  ownerUserId,
  x: 10,
  y: 5,
  rotation: 0,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
});

describe("item edit interaction", () => {
  it("hit-tests only owned items using their rotated visual bounds", () => {
    const rotated = { ...item(), rotation: Math.PI / 2 };

    expect(findOwnedItemAt([rotated], [definition], { x: 10, y: 6.9 }, "alice")?.id)
      .toBe("item-1");
    expect(findOwnedItemAt([rotated], [definition], { x: 11.9, y: 5 }, "alice"))
      .toBeUndefined();
    expect(findOwnedItemAt([rotated], [definition], { x: 10, y: 5 }, "bob"))
      .toBeUndefined();
  });

  it("hit-tests the scaled visual bounds", () => {
    expect(
      findOwnedItemAt([{ ...item(), scale: 2 }], [definition], { x: 13.8, y: 5 }, "alice"),
    ).toMatchObject({ id: "item-1" });
    expect(
      findOwnedItemAt([{ ...item(), scale: 0.5 }], [definition], { x: 11.1, y: 5 }, "alice"),
    ).toBeUndefined();
  });

  it("shows a local ghost during drag and commits its final transform on release", () => {
    const surface = new PointerSurface();
    const previews: number[] = [];
    const commits: number[] = [];
    const states: Array<{ selectedEntityId?: string; ghostX?: number }> = [];
    const controller = new ItemEditController(surface as unknown as HTMLElement, {
      enabled: () => true,
      pick: () => item(),
      toWorld: (point) => ({ x: point.x / 2, y: point.y / 2 }),
      onPreview: (_id, transform) => previews.push(transform.x),
      onCommit: (_id, transform) => commits.push(transform.x),
      onChange: (state) =>
        states.push({
          selectedEntityId: state.selectedEntityId,
          ghostX: state.ghost?.transform.x,
        }),
    });

    // Screen (20, 10) is world (10, 5), the item's centre.
    surface.emit("pointerdown", 20, 10);
    surface.emit("pointermove", 30, 14);

    expect(previews).toEqual([15]);
    expect(states.at(-1)).toEqual({ selectedEntityId: "item-1", ghostX: 15 });

    surface.emit("pointerup", 30, 14);
    expect(commits).toEqual([15]);
    expect(states.at(-1)).toEqual({ selectedEntityId: "item-1", ghostX: undefined });
    controller.destroy();
  });

  it("does nothing outside edit mode and clears selection on empty space", () => {
    const surface = new PointerSurface();
    let enabled = false;
    let pickItem = true;
    let commits = 0;
    const selected: Array<string | undefined> = [];
    const controller = new ItemEditController(surface as unknown as HTMLElement, {
      enabled: () => enabled,
      pick: () => (pickItem ? item() : undefined),
      toWorld: (point) => point,
      onPreview: () => {},
      onCommit: () => commits++,
      onChange: (state) => selected.push(state.selectedEntityId),
    });

    surface.emit("pointerdown", 10, 5);
    expect(selected).toEqual([]);

    enabled = true;
    surface.emit("pointerdown", 10, 5);
    expect(selected.at(-1)).toBe("item-1");
    surface.emit("pointerup", 10, 5);
    expect(commits).toBe(0);

    pickItem = false;
    surface.emit("pointerdown", 80, 40);
    expect(selected.at(-1)).toBeUndefined();
    controller.destroy();
  });
});
