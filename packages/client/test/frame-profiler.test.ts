import { describe, expect, it } from "vitest";
import { FrameProfiler } from "../src/render/frame-profiler.js";
import { runtimeDiagnosticsIntervalMs } from "../src/runtime/canvas-runtime.js";

describe("FrameProfiler", () => {
  it("bounds diagnostics work away from the render-frame hot path", () => {
    expect(runtimeDiagnosticsIntervalMs()).toBe(250);
    expect(runtimeDiagnosticsIntervalMs(2)).toBe(500);
    expect(runtimeDiagnosticsIntervalMs(Number.NaN)).toBe(250);
    expect(runtimeDiagnosticsIntervalMs(120)).toBeCloseTo(1000 / 60);
  });

  it("reports stable rolling frame-time percentiles and long frames", () => {
    const profiler = new FrameProfiler({ maxSamples: 5, longFrameMs: 30 });

    for (const frameMs of [10, 12, 14, 16, 40]) profiler.sample(frameMs);

    expect(profiler.diagnostics()).toEqual({
      samples: 5,
      p95Ms: 40,
      worstMs: 40,
      longFrames: 1,
    });
  });

  it("drops old frames and ignores invalid timing samples", () => {
    const profiler = new FrameProfiler({ maxSamples: 3, longFrameMs: 30 });

    for (const frameMs of [100, Number.NaN, 0, 10, 20, 30]) profiler.sample(frameMs);

    expect(profiler.diagnostics()).toEqual({
      samples: 3,
      p95Ms: 30,
      worstMs: 30,
      longFrames: 0,
    });
  });

  it("resets after a page suspension", () => {
    const profiler = new FrameProfiler();
    profiler.sample(120);

    profiler.reset();

    expect(profiler.diagnostics()).toEqual({
      samples: 0,
      p95Ms: 0,
      worstMs: 0,
      longFrames: 0,
    });
  });
});
