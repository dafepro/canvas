import { describe, expect, it } from "vitest";
import {
  runBehaviorConformance,
  type BehaviorConformanceScenario,
} from "../src/testing/index.js";
import type { ItemBehavior } from "../src/index.js";

interface CounterState { count: number }

const CounterBehavior = {
  behaviorType: "example.counter",
  stateVersion: 1,
  subscribes: ["tick"],
  initialState: (): CounterState => ({ count: 0 }),
  onEvent: (_context, _config, state) => ({
    state: { count: state.count + 1 },
    commands: [],
  }),
} satisfies ItemBehavior<Record<string, never>, CounterState>;

const scenarios: BehaviorConformanceScenario<Record<string, never>, CounterState>[] = [
  {
    name: "three ticks",
    exercise: (harness) => { harness.advance(3); },
  },
];

describe("external behavior conformance", () => {
  it("accepts deterministic data-only behavior scenarios", () => {
    const report = runBehaviorConformance(CounterBehavior, {}, { scenarios });

    expect(report).toEqual({
      ok: true,
      behaviorType: "example.counter",
      stateVersion: 1,
      scenariosRun: 1,
      issues: [],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.issues)).toBe(true);
  });

  it("reports metadata, serialization, and deterministic replay violations together", () => {
    let initial = 0;
    let eventCount = 0;
    const invalid = {
      behaviorType: "",
      stateVersion: 0,
      subscribes: ["tick", "tick", "not-an-event"],
      initialState: () => ({ initial: ++initial, invalid: BigInt(1) }),
      onEvent: () => ({ state: { eventCount: ++eventCount }, commands: [] }),
    } as unknown as ItemBehavior<Record<string, never>, { eventCount: number }>;

    const report = runBehaviorConformance(invalid, {}, {
      scenarios: [{ name: "tick", exercise: (harness) => { harness.advance(); } }],
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "invalid_behavior_type",
      "invalid_state_version",
      "duplicate_subscription",
      "unknown_subscription",
      "initial_state_not_serializable",
      "initial_state_not_deterministic",
      "scenario_not_deterministic",
    ]));
  });

  it("requires at least one consumer-owned scenario and isolates scenario failures", () => {
    expect(runBehaviorConformance(CounterBehavior, {}, { scenarios: [] }).issues)
      .toContainEqual(expect.objectContaining({ code: "scenario_required" }));

    const report = runBehaviorConformance(CounterBehavior, {}, {
      scenarios: [{ name: "broken", exercise: () => { throw new Error("boom"); } }],
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "scenario_failed",
      scenario: "broken",
      message: expect.stringContaining("boom"),
    }));
  });

  it("requires durable migration coverage for every prior state version", () => {
    const versioned = {
      ...CounterBehavior,
      behaviorType: "example.versioned",
      stateVersion: 3,
    } satisfies ItemBehavior<Record<string, never>, CounterState>;

    const report = runBehaviorConformance(versioned, {}, { scenarios });

    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "missing_migrations",
    }));
  });

  it("reports sleep-normalization failures instead of escaping the kit", () => {
    const report = runBehaviorConformance({
      ...CounterBehavior,
      behaviorType: "example.bad-normalization",
      normalizeForSleep: () => { throw new Error("cannot normalize"); },
    }, {}, { scenarios });

    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "normalization_failed",
      message: expect.stringContaining("cannot normalize"),
    }));
  });
});
