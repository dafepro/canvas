import { describe, expect, it } from "vitest";
import {
  EnvironmentField,
  resolveEdges,
  softSpeedLimitForce,
  stepElevation,
  type CanvasDefinition,
  type ElevationComponent,
  type EnvironmentDefinition,
} from "../src/index.js";

// The rocket canvas from spec section 18.
const rocketEnvironment: EnvironmentDefinition = {
  base: { gravityXY: { x: 0, y: 20 }, linearDrag: 0.1 },
  regions: [
    {
      id: "space-gradient",
      shape: { type: "rect", x: 0, y: 0, w: 100, h: 40 },
      blend: "linear",
      axis: "y",
      from: 40,
      to: 10,
      priority: 0,
      gravityScale: [1.0, 0.1],
      linearDrag: [0.1, 0.45],
      softSpeedLimit: [null, 12],
    },
  ],
};

describe("EnvironmentField", () => {
  const field = new EnvironmentField(rocketEnvironment);

  it("returns the canvas defaults outside every region", () => {
    const sample = field.sample({ x: 50, y: 60 });
    expect(sample.gravityXY).toEqual({ x: 0, y: 20 });
    expect(sample.linearDrag).toBeCloseTo(0.1);
    expect(sample.softSpeedLimit).toBeNull();
  });

  it("reduces gravity smoothly through the upper canvas", () => {
    const low = field.sample({ x: 50, y: 40 });
    const middle = field.sample({ x: 50, y: 25 });
    const high = field.sample({ x: 50, y: 10 });
    expect(low.gravityXY.y).toBeCloseTo(20);
    expect(middle.gravityXY.y).toBeGreaterThan(high.gravityXY.y);
    expect(middle.gravityXY.y).toBeLessThan(low.gravityXY.y);
    expect(high.gravityXY.y).toBeCloseTo(2);
  });

  it("raises drag and applies a soft speed cap in space", () => {
    const high = field.sample({ x: 50, y: 10 });
    expect(high.linearDrag).toBeCloseTo(0.45);
    expect(high.softSpeedLimit).toBeCloseTo(12);
  });

  it("applies region modifiers in priority order", () => {
    const layered = new EnvironmentField({
      base: { gravityXY: { x: 0, y: 10 }, linearDrag: 0 },
      regions: [
        {
          id: "high",
          shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
          blend: "step",
          priority: 5,
          linearDrag: 2,
        },
        {
          id: "low",
          shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
          blend: "step",
          priority: 1,
          linearDrag: 1,
        },
      ],
    });
    expect(layered.sample({ x: 5, y: 5 }).linearDrag).toBe(2);
  });

  it("blends radially inside a circle", () => {
    const radial = new EnvironmentField({
      base: { gravityXY: { x: 0, y: 0 }, linearDrag: 0 },
      regions: [
        {
          id: "well",
          shape: { type: "circle", x: 0, y: 0, radius: 10 },
          blend: "radial",
          priority: 0,
          linearDrag: 1,
        },
      ],
    });
    expect(radial.sample({ x: 0, y: 0 }).linearDrag).toBeCloseTo(1);
    expect(radial.sample({ x: 5, y: 0 }).linearDrag).toBeCloseTo(0.5);
    expect(radial.sample({ x: 20, y: 0 }).linearDrag).toBe(0);
  });

  it("lists the regions that contain a point", () => {
    expect(field.regionsAt({ x: 50, y: 20 })).toEqual(["space-gradient"]);
    expect(field.regionsAt({ x: 50, y: 60 })).toEqual([]);
  });
});

describe("softSpeedLimitForce", () => {
  it("does nothing below the limit", () => {
    expect(softSpeedLimitForce({ x: 5, y: 0 }, 12)).toEqual({ x: 0, y: 0 });
  });

  it("adds drag only to the velocity above the limit", () => {
    const force = softSpeedLimitForce({ x: 20, y: 0 }, 12, 4);
    expect(force.x).toBeCloseTo(-32);
    expect(force.y).toBeCloseTo(0);
  });

  it("does nothing when no limit is set", () => {
    expect(softSpeedLimitForce({ x: 100, y: 0 }, null)).toEqual({ x: 0, y: 0 });
  });
});

const canvas = (
  edges: CanvasDefinition["edges"],
  spawnPoints: CanvasDefinition["spawnPoints"] = [],
): CanvasDefinition => ({
  id: "c",
  version: 1,
  size: { width: 100, height: 70 },
  orientation: "side",
  edges,
  staticGeometry: [],
  regions: [],
  environment: { base: { gravityXY: { x: 0, y: 20 }, linearDrag: 0.1 } },
  spawnPoints,
  limits: { maxAvatars: 20, maxItems: 50, maxComplexPhysicsItems: 5 },
});

describe("resolveEdges", () => {
  const allWrap = canvas({ top: "wrap", right: "wrap", bottom: "wrap", left: "wrap" });

  it("reports nothing inside the canvas", () => {
    expect(resolveEdges(allWrap, { x: 50, y: 35 }, { x: 1, y: 1 }).crossings).toHaveLength(0);
  });

  it("wraps to the opposite edge and preserves velocity", () => {
    const result = resolveEdges(allWrap, { x: -1, y: 35 }, { x: -5, y: 0 });
    expect(result.crossings[0]).toEqual({ edge: "left", policy: "wrap" });
    expect(result.position!.x).toBe(100);
    expect(result.velocity).toBeUndefined();
  });

  it("ignores a solid edge because a static collider stops the body", () => {
    const solid = canvas({ top: "solid", right: "solid", bottom: "solid", left: "solid" });
    expect(resolveEdges(solid, { x: -1, y: 35 }, { x: 0, y: 0 }).crossings).toHaveLength(0);
  });

  it("respawns at the spawn point with zero motion", () => {
    const respawn = canvas(
      { top: "open", right: "solid", bottom: "respawn", left: "solid" },
      [{ id: "centre", position: { x: 50, y: 35 } }],
    );
    const result = resolveEdges(respawn, { x: 50, y: 80 }, { x: 3, y: 9 });
    expect(result.respawn).toBe(true);
    expect(result.spawnPointId).toBe("centre");
    expect(result.position).toEqual({ x: 50, y: 35 });
    expect(result.velocity).toEqual({ x: 0, y: 0 });
  });

  it("reports an open edge without moving the body", () => {
    const open = canvas({ top: "open", right: "solid", bottom: "solid", left: "solid" });
    const result = resolveEdges(open, { x: 50, y: -5 }, { x: 0, y: -9 });
    expect(result.crossings[0]).toEqual({ edge: "top", policy: "open" });
    expect(result.respawn).toBeUndefined();
  });
});

describe("stepElevation", () => {
  const sample = {
    gravityXY: { x: 0, y: 0 },
    linearDrag: 0,
    angularDrag: 0,
    softSpeedLimit: null,
    surfaceFrictionMultiplier: 1,
    zGravity: 20,
    zDrag: 0,
  };

  const airborne = (overrides: Partial<ElevationComponent> = {}): ElevationComponent => ({
    enabled: true,
    groundZ: 0,
    z: 5,
    vz: -10,
    grounded: false,
    ...overrides,
  });

  it("integrates the elevation channel and reports the landing", () => {
    const elevation = airborne();
    let landed = false;
    for (let i = 0; i < 200 && !landed; i++) {
      landed = stepElevation(elevation, sample, 1 / 60).landed;
    }
    expect(landed).toBe(true);
    expect(elevation.z).toBe(0);
    expect(elevation.vz).toBe(0);
    expect(elevation.grounded).toBe(true);
  });

  it("bounces when the elevation has restitution", () => {
    const elevation = airborne({ z: 0.01, vz: -8, restitution: 0.5 });
    const result = stepElevation(elevation, sample, 1 / 60);
    expect(result.landed).toBe(true);
    expect(elevation.vz).toBeGreaterThan(0);
    expect(elevation.grounded).toBe(false);
  });

  it("does nothing when elevation is disabled", () => {
    const elevation = airborne({ enabled: false });
    expect(stepElevation(elevation, sample, 1 / 60)).toEqual({ landed: false, impactSpeed: 0 });
    expect(elevation.z).toBe(5);
  });
});
