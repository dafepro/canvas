import { describe, expect, it } from "vitest";
import {
  BehaviorRegistry,
  BehaviorRuntime,
  MigrationChain,
  sortEvents,
  type BehaviorEvent,
  type ItemBehavior,
} from "../src/index.js";
import { BehaviorTestHost } from "../src/testing/index.js";

const canvas = { id: "c", width: 100, height: 70, orientation: "side" as const };

interface RecorderState {
  seen: string[];
}

const Recorder: ItemBehavior<{ force: number }, RecorderState> = {
  behaviorType: "recorder",
  stateVersion: 1,
  initialState: () => ({ seen: [] }),
  onEvent: (_ctx, config, state, event) => ({
    state: { seen: [...state.seen, event.type] },
    // A command that would be visible to a later handler if applied too early.
    commands: [{ type: "applyForce", force: { x: config.force, y: 0 } }],
  }),
};

describe("event ordering", () => {
  it("puts exits before enters and tick last", () => {
    const events = [
      { type: "tick", tick: 1, self: "a", dt: 1 / 60 },
      { type: "contact.enter", tick: 1, self: "a", other: {} },
      { type: "contact.exit", tick: 1, self: "a", other: {}, dwellTicks: 2 },
      { type: "room.wake", tick: 1, self: "a", fromSnapshot: false },
    ] as unknown as BehaviorEvent[];
    expect(sortEvents(events).map((e) => e.type)).toEqual([
      "room.wake",
      "contact.exit",
      "contact.enter",
      "tick",
    ]);
  });

  it("keeps the queue order for events of the same type", () => {
    const events = [
      { type: "timer", tick: 1, self: "a", timerId: "1", key: "first", elapsedTicks: 1 },
      { type: "timer", tick: 1, self: "a", timerId: "2", key: "second", elapsedTicks: 1 },
    ] as unknown as BehaviorEvent[];
    expect(sortEvents(events).map((e) => (e as { key: string }).key)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("BehaviorRuntime", () => {
  const build = () => {
    const registry = new BehaviorRegistry().register(Recorder);
    const host = new BehaviorTestHost();
    host.body("item-1");
    const runtime = new BehaviorRuntime(registry, host, canvas, 60);
    runtime.attach({
      entityId: "item-1",
      behaviorType: "recorder",
      config: { force: 5 },
      persistent: false,
    });
    return { runtime, host };
  };

  it("applies commands only after every handler has run", () => {
    const { runtime, host } = build();
    runtime.emit({ type: "contact.enter", tick: 1, self: "item-1", other: {} } as never);
    runtime.emit({ type: "tick", tick: 1, self: "item-1", dt: 1 / 60 });
    const report = runtime.step(1);
    expect(report.eventsProcessed).toBe(2);
    expect(host.body("item-1").forces).toHaveLength(2);
    expect(runtime.slot("item-1")!.state).toEqual({ seen: ["contact.enter", "tick"] });
  });

  it("keeps one behavior error from stopping the others", () => {
    const registry = new BehaviorRegistry().register(Recorder).register({
      behaviorType: "thrower",
      stateVersion: 1,
      initialState: () => ({}),
      onEvent: () => {
        throw new Error("boom");
      },
    } as ItemBehavior<unknown, unknown>);
    const host = new BehaviorTestHost();
    const runtime = new BehaviorRuntime(registry, host, canvas, 60);
    runtime.attach({ entityId: "bad", behaviorType: "thrower", config: {}, persistent: false });
    runtime.attach({
      entityId: "good",
      behaviorType: "recorder",
      config: { force: 1 },
      persistent: false,
    });
    runtime.emit({ type: "tick", tick: 1, self: "bad", dt: 1 / 60 });
    runtime.emit({ type: "tick", tick: 1, self: "good", dt: 1 / 60 });
    const report = runtime.step(1);
    expect(report.errors).toHaveLength(1);
    expect(report.eventsProcessed).toBe(1);
    expect(runtime.slot("good")!.state).toEqual({ seen: ["tick"] });
  });

  it("drops events for a detached entity", () => {
    const { runtime } = build();
    runtime.detach("item-1");
    runtime.emit({ type: "tick", tick: 1, self: "item-1", dt: 1 / 60 });
    expect(runtime.step(1).eventsProcessed).toBe(0);
  });

  it("respects the subscribes list", () => {
    const registry = new BehaviorRegistry().register({
      ...Recorder,
      behaviorType: "picky",
      subscribes: ["timer"],
    });
    const host = new BehaviorTestHost();
    const runtime = new BehaviorRuntime(registry, host, canvas, 60);
    runtime.attach({ entityId: "a", behaviorType: "picky", config: { force: 1 }, persistent: false });
    runtime.emit({ type: "tick", tick: 1, self: "a", dt: 1 / 60 });
    expect(runtime.step(1).eventsProcessed).toBe(0);
  });

  it("migrates attached persisted state to the behavior's current version", () => {
    const migrations = new MigrationChain<{ value: number }>(3)
      .step(1, (state) => ({ value: state.value + 10 }))
      .step(2, (state) => ({ value: state.value * 2 }));
    const registry = new BehaviorRegistry().register({
      behaviorType: "migrating",
      stateVersion: 3,
      migrations,
      initialState: () => ({ value: 0 }),
      onEvent: (_ctx, _config, state) => ({ state, commands: [] }),
    } satisfies ItemBehavior<unknown, { value: number }>);
    const runtime = new BehaviorRuntime(
      registry,
      new BehaviorTestHost(),
      canvas,
      60,
    );

    const slot = runtime.attach({
      entityId: "old-item",
      behaviorType: "migrating",
      config: {},
      state: { value: 1 },
      stateVersion: 1,
      persistent: true,
    });

    expect(slot.state).toEqual({ value: 22 });
    expect(slot.stateVersion).toBe(3);
  });
});

describe("TimerService", () => {
  it("counts simulation ticks, not wall-clock time", () => {
    const { runtime } = build30();
    runtime.timers.schedule("a", "k", 2, 0);
    expect(runtime.timers.remaining("a", "k", 0)).toBe(60);
    expect(runtime.timers.collectDue(59)).toHaveLength(0);
    expect(runtime.timers.collectDue(60)).toHaveLength(1);
  });

  it("replaces a timer with the same key by default", () => {
    const { runtime } = build30();
    runtime.timers.schedule("a", "k", 2, 0);
    runtime.timers.schedule("a", "k", 1, 0);
    expect(runtime.timers.pending).toBe(1);
    expect(runtime.timers.remaining("a", "k", 0)).toBe(30);
  });

  it("clears every timer for room sleep", () => {
    const { runtime } = build30();
    runtime.timers.schedule("a", "k", 2, 0);
    runtime.timers.clear();
    expect(runtime.timers.pending).toBe(0);
  });

  it("captures and restores elapsed and remaining ticks for host migration", () => {
    const first = build30().runtime;
    first.timers.schedule("a", "countdown", 2, 100);
    const snapshot = first.timers.snapshot("a", 130);
    expect(snapshot).toEqual([
      { key: "countdown", elapsedTicks: 30, remainingTicks: 30 },
    ]);

    const second = build30().runtime;
    second.timers.restore("a", snapshot, 500);
    expect(second.timers.collectDue(529)).toHaveLength(0);
    expect(second.timers.collectDue(530)).toEqual([
      expect.objectContaining({ key: "countdown", elapsedTicks: 60 }),
    ]);
  });

  function build30() {
    const registry = new BehaviorRegistry().register(Recorder);
    const runtime = new BehaviorRuntime(registry, new BehaviorTestHost(), canvas, 30);
    return { runtime };
  }
});

describe("MigrationChain", () => {
  it("runs each step in order", () => {
    const chain = new MigrationChain<{ v: number }>(3)
      .step(1, (s) => ({ v: s.v + 10 }))
      .step(2, (s) => ({ v: s.v * 2 }));
    expect(chain.migrate({ v: 1 }, 1)).toEqual({ v: 22 });
    expect(chain.migrate({ v: 1 }, 3)).toEqual({ v: 1 });
  });

  it("refuses a missing step and a newer version", () => {
    const chain = new MigrationChain<{ v: number }>(3);
    expect(() => chain.migrate({ v: 1 }, 1)).toThrow(/no migration/);
    expect(() => chain.migrate({ v: 1 }, 4)).toThrow(/newer than supported/);
  });
});

describe("BehaviorRegistry", () => {
  it("refuses a duplicate behavior type", () => {
    const registry = new BehaviorRegistry().register(Recorder);
    expect(() => registry.register(Recorder)).toThrow(/already registered/);
  });

  it("reports an unknown behavior type", () => {
    expect(() => new BehaviorRegistry().require("nope")).toThrow(/unknown behavior type/);
  });
});
