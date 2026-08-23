import { describe, expect, it } from "vitest";
import {
  RocketBehavior,
  defaultRocketConfig,
  type RocketConfig,
  type RocketState,
} from "../src/index.js";
import {
  BehaviorTestHarness,
  avatarParty,
  staticParty,
} from "../src/testing/index.js";

const harness = (overrides: Partial<RocketConfig> = {}) =>
  new BehaviorTestHarness<RocketConfig, RocketState>(RocketBehavior, {
    ...defaultRocketConfig,
    ...overrides,
  });

const arm = (h: ReturnType<typeof harness>, count = 1) =>
  h.send({
    type: "contact.count",
    colliderId: "arm",
    count,
    previousCount: count - 1,
    parties: [avatarParty("avatar-1")],
  }).flush();

describe("RocketBehavior", () => {
  it("starts idle", () => {
    expect(harness().state.phase).toBe("idle");
  });

  it("arms on a qualifying contact and starts the countdown", () => {
    const h = harness();
    arm(h);
    expect(h.state.phase).toBe("arming");
    expect(h.state.countdownTicks).toBe(180);
    expect(h.commands("scheduleTimer")).toHaveLength(1);
    expect(h.effects("countdown")[0]?.mode).toBe("start");
  });

  it("launches when the countdown expires", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    expect(h.state.phase).toBe("flying");
    expect(h.state.launchCount).toBe(1);
    const impulse = h.commands("applyImpulse")[0];
    expect(impulse).toMatchObject({ type: "applyImpulse", local: true });
    expect(h.effects("thrustTrail")[0]?.mode).toBe("start");
  });

  it("keeps the countdown after one touch when the grace time is longer", () => {
    // Data only: a grace time above the countdown makes one touch enough.
    const h = harness({ graceSeconds: 3.5 });
    arm(h).advanceSeconds(0.5);
    h.send({
      type: "contact.count",
      colliderId: "arm",
      count: 0,
      previousCount: 1,
      parties: [],
    }).advanceSeconds(2.5);
    expect(h.state.phase).toBe("flying");
  });

  it("disarms when the contact stops before the countdown finishes", () => {
    const h = harness();
    arm(h).advanceSeconds(1);
    h.send({
      type: "contact.count",
      colliderId: "arm",
      count: 0,
      previousCount: 1,
      parties: [],
    }).advanceSeconds(1);
    expect(h.state.phase).toBe("idle");
    expect(h.state.launchCount).toBe(0);
  });

  it("keeps arming when the contact returns inside the grace window", () => {
    const h = harness();
    arm(h).advanceSeconds(0.5);
    h.send({ type: "contact.count", colliderId: "arm", count: 0, previousCount: 1, parties: [] })
      .advance(10);
    arm(h).advanceSeconds(2.6);
    expect(h.state.phase).toBe("flying");
  });

  it("requires the configured number of avatars", () => {
    const h = harness({ requiredContacts: 2 });
    arm(h, 1);
    expect(h.state.phase).toBe("idle");
    arm(h, 2);
    expect(h.state.phase).toBe("arming");
  });

  it("applies thrust for the configured duration only", () => {
    const h = harness({ thrustSeconds: 0.5 });
    arm(h).advanceSeconds(3);
    const before = h.commands("applyForce").length;
    h.advanceSeconds(0.5);
    const during = h.commands("applyForce").length;
    h.advanceSeconds(1);
    expect(during).toBeGreaterThan(before);
    expect(h.commands("applyForce").length).toBe(30);
    expect(h.state.thrustTicksRemaining).toBe(0);
  });

  it("runs the full space and return loop", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    h.send({ type: "region.enter", regionId: "space", tags: ["space"] }).flush();
    expect(h.state.phase).toBe("spaceDrift");

    h.send({
      type: "region.exit",
      regionId: "space",
      tags: ["space"],
      velocity: { x: 0, y: 6 },
    }).flush();
    expect(h.state.phase).toBe("falling");

    h.host.body(h.entityId).velocity = { x: 0, y: 1 };
    h.send({ type: "contact.enter", other: staticParty("ground", ["ground"]) }).flush();
    expect(h.state.phase).toBe("landed");
    expect(h.effects("landingDust")).toHaveLength(1);

    h.advanceSeconds(1.5);
    expect(h.state.phase).toBe("idle");
  });

  it("does not leave space while still rising", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    h.send({ type: "region.enter", regionId: "space", tags: ["space"] }).flush();
    h.send({
      type: "region.exit",
      regionId: "space",
      tags: ["space"],
      velocity: { x: 0, y: -6 },
    }).flush();
    expect(h.state.phase).toBe("spaceDrift");
  });

  it("bursts instead of landing above the landing speed threshold", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    h.host.body(h.entityId).velocity = { x: 0, y: 30 };
    h.send({ type: "contact.enter", other: staticParty("ground", ["ground"]) }).flush();
    expect(h.state.phase).toBe("flying");
    expect(h.effects("impactBurst")).toHaveLength(1);
  });

  it("resets transient state for room sleep but keeps the launch count", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    h.runtime.normalizeForSleep();
    expect(h.state).toMatchObject({ phase: "idle", launchCount: 1, thrustTicksRemaining: 0 });
    expect(h.runtime.timers.pending).toBe(0);
  });

  it("returns to idle on room wake", () => {
    const h = harness();
    arm(h).advanceSeconds(3);
    h.send({ type: "room.wake", fromSnapshot: true }).flush();
    expect(h.state.phase).toBe("idle");
  });

  it("derives the countdown overlay from the activation tick", () => {
    const h = harness();
    h.advance(30);
    arm(h);
    expect(h.state.armedAtTick).toBe(30);
    expect(h.state.countdownTicks).toBe(180);
  });
});
