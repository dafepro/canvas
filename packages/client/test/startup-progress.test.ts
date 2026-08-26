import { describe, expect, it, vi } from "vitest";
import { lifecycleError } from "../src/runtime/lifecycle.js";
import {
  RuntimeStartupProgressCoordinator,
  StartupProgress,
  type RuntimeStartupActivePhase,
  type RuntimeStartupSnapshot,
} from "../src/runtime/startup-progress.js";

const phases: RuntimeStartupActivePhase[] = [
  "assets",
  "credentials",
  "connecting",
  "joining",
  "simulation",
  "canonical",
  "presenting",
  "ready",
];

describe("StartupProgress", () => {
  it("replays immutable snapshots and records a monotonic phase timeline", () => {
    let now = 10;
    const progress = new StartupProgress("assets", () => now);
    const observed: RuntimeStartupSnapshot[] = [];
    progress.subscribe((snapshot) => observed.push(snapshot));

    now = 20;
    progress.advance("credentials");
    now = 35;
    progress.advance("connecting");
    now = 40;
    progress.advance("credentials");

    expect(observed.map(({ phase }) => phase)).toEqual([
      "assets",
      "credentials",
      "connecting",
    ]);
    expect(progress.snapshot).toMatchObject({
      phase: "connecting",
      startedAtMs: 10,
      phaseStartedAtMs: 35,
      completedPhases: [
        { phase: "assets", startedAtMs: 10, completedAtMs: 20 },
        { phase: "credentials", startedAtMs: 20, completedAtMs: 35 },
      ],
    });
    expect(Object.isFrozen(progress.snapshot)).toBe(true);
    expect(Object.isFrozen(progress.snapshot.completedPhases)).toBe(true);
    expect(Object.isFrozen(progress.snapshot.completedPhases[0])).toBe(true);
  });

  it.each(phases.slice(0, -1))(
    "can fail while %s is stalled and settles only once",
    (phase) => {
      const progress = new StartupProgress(phase, () => 100);
      const snapshots: RuntimeStartupSnapshot[] = [];
      progress.subscribe((snapshot) => snapshots.push(snapshot));
      const error = lifecycleError(
        phase === "assets" ? "asset_preload_failed" : "transport_connection_failed",
        `${phase} failed`,
        { source: phase === "assets" ? "assets" : "transport" },
      );

      progress.fail(error);
      progress.fail(lifecycleError("transport_closed", "late"));
      progress.advance("ready");

      expect(progress.snapshot.phase).toBe("failed");
      expect(progress.snapshot.error).toBe(error);
      expect(progress.snapshot.completedAtMs).toBe(100);
      expect(snapshots.map(({ phase: value }) => value)).toEqual([phase, "failed"]);
    },
  );

  it("publishes typed cancellation before readiness but keeps readiness sticky", () => {
    let now = 5;
    const cancelled = new StartupProgress("joining", () => now);
    now = 8;
    cancelled.cancel("consumer stopped startup");

    expect(cancelled.snapshot).toMatchObject({
      phase: "cancelled",
      completedAtMs: 8,
      error: {
        code: "start_cancelled",
        source: "lifecycle",
        recoverable: false,
        message: "consumer stopped startup",
      },
    });

    const ready = new StartupProgress("presenting", () => now);
    ready.advance("ready");
    ready.cancel("late stop");
    ready.fail(lifecycleError("transport_closed", "late failure"));
    expect(ready.snapshot.phase).toBe("ready");
  });

  it("publishes source-aware asset settlement without allowing late asset updates", () => {
    const progress = new StartupProgress("assets", () => 1);
    progress.updateAssets({
      settled: 1,
      total: 2,
      ratio: 0.5,
      sources: [
        { sourceId: "field", required: true, status: "loaded" },
        { sourceId: "music", required: false, status: "pending" },
      ],
    });

    expect(progress.snapshot.assets).toEqual({
      settled: 1,
      total: 2,
      ratio: 0.5,
      sources: [
        { sourceId: "field", required: true, status: "loaded" },
        { sourceId: "music", required: false, status: "pending" },
      ],
    });
    expect(Object.isFrozen(progress.snapshot.assets)).toBe(true);
    expect(Object.isFrozen(progress.snapshot.assets?.sources)).toBe(true);

    progress.advance("credentials");
    progress.updateAssets({ settled: 2, total: 2, ratio: 1, sources: [] });
    expect(progress.snapshot.assets?.settled).toBe(1);
  });

  it("unsubscribes cleanly and isolates throwing observers", () => {
    const progress = new StartupProgress("credentials", () => 1);
    const healthy = vi.fn();
    progress.subscribe(() => { throw new Error("consumer bug"); });
    const unsubscribe = progress.subscribe(healthy);

    progress.advance("connecting");
    unsubscribe();
    progress.advance("joining");

    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("settles readiness waiters from the same terminal state machine", async () => {
    const ready = new StartupProgress("presenting", () => 1);
    const first = ready.waitUntilReady();
    const second = ready.waitUntilReady();
    ready.advance("ready");
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(ready.waitUntilReady()).resolves.toBeUndefined();

    const failed = new StartupProgress("canonical", () => 1);
    const rejected = failed.waitUntilReady();
    const error = lifecycleError("transport_closed", "gone", { source: "transport" });
    failed.fail(error);
    await expect(rejected).rejects.toBe(error);
    await expect(failed.waitUntilReady()).rejects.toBe(error);
  });
});

describe("RuntimeStartupProgressCoordinator", () => {
  it("holds room progress behind assets and waits for an actual presented frame", async () => {
    const runtime = new RuntimeStartupProgressCoordinator(() => 1);
    runtime.configureAssets([
      { id: "field", required: true },
      { id: "music", required: false },
    ]);
    const room = new StartupProgress("credentials", () => 1);
    const phases: string[] = [];
    runtime.subscribe((snapshot) => phases.push(snapshot.phase));
    room.subscribe((snapshot) => runtime.acceptSession(snapshot));

    expect(runtime.snapshot).toMatchObject({
      phase: "assets",
      assets: { settled: 0, total: 2, ratio: 0 },
    });
    runtime.completeAssets();
    expect(runtime.snapshot.phase).toBe("credentials");

    for (const phase of [
      "connecting",
      "joining",
      "simulation",
      "canonical",
      "presenting",
      "ready",
    ] as const) room.advance(phase);

    expect(runtime.snapshot.phase).toBe("presenting");
    expect(phases).not.toContain("ready");
    const ready = runtime.waitUntilReady();
    runtime.markPresentedFrame();
    await expect(ready).resolves.toBeUndefined();
    expect(runtime.snapshot.phase).toBe("ready");
  });

  it("forwards room failure and cancels pending browser startup exactly once", () => {
    const failed = new RuntimeStartupProgressCoordinator(() => 2);
    failed.completeAssets();
    const error = lifecycleError("transport_connection_failed", "offline", {
      source: "transport",
    });
    failed.acceptSession(Object.freeze({
      phase: "failed",
      startedAtMs: 1,
      phaseStartedAtMs: 2,
      completedAtMs: 2,
      completedPhases: Object.freeze([]),
      error,
    }));
    expect(failed.snapshot).toMatchObject({ phase: "failed", error });

    const cancelled = new RuntimeStartupProgressCoordinator(() => 3);
    cancelled.cancel();
    cancelled.completeAssets();
    cancelled.markPresentedFrame();
    expect(cancelled.snapshot.phase).toBe("cancelled");
  });
});
