import { describe, expect, it, vi } from "vitest";
import {
  OverlayProjectionStore,
  projectOverlayPoint,
  type OverlayProjectionSource,
} from "../src/render/overlay-projection.js";

const source = (sampledAtMs: number): OverlayProjectionSource => ({
  sampledAtMs,
  tick: sampledAtMs,
  canvasSize: { width: 100, height: 60 },
  viewport: {
    width: 1_000,
    height: 700,
    scale: 10,
    offsetX: 0,
    offsetY: 50,
  },
  entities: [
    {
      id: "ball",
      kind: "item",
      definitionId: "soccer-ball",
      x: 50,
      y: 30,
      z: 2,
      rotation: 0.25,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
    },
    {
      id: "avatar:bob",
      kind: "avatar",
      definitionId: "avatar",
      x: 10,
      y: 20,
      rotation: 0,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
      disabled: true,
    },
    {
      id: "goal",
      kind: "item",
      definitionId: "goal",
      x: 98,
      y: 30,
      rotation: 0,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
      respawning: true,
    },
  ],
});

describe("bounded overlay projection", () => {
  it("publishes immutable plain-data screen projections at a bounded rate", () => {
    const store = new OverlayProjectionStore();
    const observer = vi.fn();
    store.subscribe(observer, { maxHz: 10, kinds: ["item"] });

    store.publish(source(0));
    store.publish(source(50));
    store.publish(source(100));

    expect(observer).toHaveBeenCalledTimes(2);
    const snapshot = observer.mock.calls[0][0];
    expect(snapshot.entities).toEqual([
      expect.objectContaining({
        entityId: "ball",
        world: { x: 50, y: 30, z: 2 },
        screen: { x: 500, y: 330 },
        inViewport: true,
        visible: true,
      }),
      expect.objectContaining({ entityId: "goal", visible: false }),
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entities)).toBe(true);
    expect(Object.isFrozen(snapshot.entities[0].screen)).toBe(true);
  });

  it("filters before applying a deterministic entity bound and reports truncation", () => {
    const store = new OverlayProjectionStore();
    const observer = vi.fn();
    store.subscribe(observer, {
      maxEntities: 1,
      definitionIds: ["goal", "soccer-ball"],
    });

    store.publish(source(0));

    expect(observer.mock.calls[0][0]).toMatchObject({
      truncated: true,
      matchedEntities: 2,
      entities: [{ entityId: "ball" }],
    });
  });

  it("rejects subscriptions that could bypass the public observation budgets", () => {
    const store = new OverlayProjectionStore();
    expect(() => store.subscribe(() => undefined, { maxHz: 31 })).toThrow(RangeError);
    expect(() => store.subscribe(() => undefined, { maxEntities: 257 })).toThrow(RangeError);
    expect(() => store.subscribe(() => undefined, { entityIds: Array(257).fill("x") }))
      .toThrow(RangeError);
  });

  it("unsubscribes and clears observers without retaining renderer state", () => {
    const store = new OverlayProjectionStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = store.subscribe(first);
    store.subscribe(second);
    unsubscribe();
    store.clear();

    store.publish(source(0));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("projects consumer-owned world anchors through a plain immutable camera value", () => {
    const projected = projectOverlayPoint(
      { x: 4, y: 6, z: 1 },
      { width: 100, height: 60 },
      { width: 1_000, height: 700, scale: 10, offsetX: 0, offsetY: 50 },
    );

    expect(projected).toEqual({
      world: { x: 4, y: 6, z: 1 },
      screen: { x: 40, y: 100 },
      inCanvas: true,
      inViewport: true,
    });
    expect(Object.isFrozen(projected)).toBe(true);
  });
});
