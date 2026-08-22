import { describe, expect, it } from "vitest";
import { InterpolationBuffer } from "../src/render/interpolation-buffer.js";
import type { RenderEntity } from "../src/simulation/messages.js";

const entity = (x: number, y: number, teleportEpoch: number): RenderEntity => ({
  id: "avatar:a",
  kind: "avatar",
  definitionId: "avatar",
  x,
  y,
  rotation: 0,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
  teleportEpoch,
});

/**
 * Addendum A2. A wrap moves the body from one edge to the other. A blend
 * between the two ends would slide the sprite back across the whole canvas.
 */
describe("InterpolationBuffer and a teleport", () => {
  it("blends two states that share a teleport epoch", () => {
    const buffer = new InterpolationBuffer({ delayMs: 100 });
    buffer.push(1, [entity(10, 0, 0)], 0);
    buffer.push(2, [entity(20, 0, 0)], 100);
    const drawn = buffer.sample(150);
    expect(drawn[0]!.x).toBeGreaterThan(10);
    expect(drawn[0]!.x).toBeLessThan(20);
  });

  it("snaps to the newer state when the teleport epoch changed", () => {
    const buffer = new InterpolationBuffer({ delayMs: 100 });
    buffer.push(1, [entity(0, 1, 0)], 0);
    buffer.push(2, [entity(0, 69, 1)], 100);
    const drawn = buffer.sample(150);
    expect(drawn[0]!.y).toBe(69);
  });
});
