import { describe, expect, it } from "vitest";
import type { RenderEntity } from "../src/index.js";
import { AvatarReconciler } from "../src/index.js";

const canonical = (x: number, teleportEpoch = 0): RenderEntity => ({
  id: "avatar:peer",
  kind: "avatar",
  definitionId: "avatar",
  x,
  y: 0,
  rotation: 0,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
  teleportEpoch,
});

describe("AvatarReconciler", () => {
  it("eases toward new canonical errors without replacing presentation offsets", () => {
    const reconciler = new AvatarReconciler({ blendPerFrame: 0.1 });
    const predicted = { x: 10, y: 0 };

    reconciler.observe(canonical(9), predicted);
    expect(reconciler.correct(predicted).x).toBeCloseTo(9.9);
    expect(reconciler.correct(predicted).x).toBeCloseTo(9.81);

    reconciler.observe(canonical(9.5), predicted);
    expect(reconciler.correct(predicted).x).toBeCloseTo(9.779);
  });

  it("uses the canonical position immediately for a teleport epoch", () => {
    const reconciler = new AvatarReconciler();
    reconciler.observe(canonical(5, 1), { x: 5, y: 0 });
    reconciler.correct({ x: 5, y: 0 });

    reconciler.observe(canonical(30, 2), { x: 7, y: 0 });
    expect(reconciler.correct({ x: 7, y: 0 })).toEqual({ x: 30, y: 0 });
    expect(reconciler.snapCount).toBe(1);
  });
});
