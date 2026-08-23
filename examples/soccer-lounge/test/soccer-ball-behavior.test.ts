import { describe, expect, it } from "vitest";
import { BehaviorTestHarness, avatarParty } from "@canvas-physics/core";
import {
  SoccerBallBehavior,
  defaultSoccerBallConfig,
  type SoccerBallConfig,
  type SoccerBallState,
} from "../src/soccer-ball-behavior.js";

const harness = () =>
  new BehaviorTestHarness<SoccerBallConfig, SoccerBallState>(
    SoccerBallBehavior,
    defaultSoccerBallConfig,
    { canvas: { orientation: "topDown", width: 120, height: 80 } },
  );

describe("SoccerBallBehavior", () => {
  it("starts a scoreless match", () => {
    expect(harness().state).toMatchObject({
      phase: "playing",
      homeScore: 0,
      awayScore: 0,
      kickCount: 0,
    });
  });

  it("lets a moving avatar kick the ball", () => {
    const h = harness();
    h.host.body(h.entityId).transform = { x: 50, y: 40, rotation: 0 };
    h.host.body("avatar-1", { x: 47, y: 40 }).velocity = { x: 8, y: 0 };

    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();

    expect(h.state.kickCount).toBe(1);
    expect(h.commands("applyImpulse")).toHaveLength(1);
    expect(h.host.body(h.entityId).velocity.x).toBeGreaterThan(0);
  });

  it("scores for away at the left goal, stops, then resets at centre", () => {
    const h = harness();
    h.host.body(h.entityId).velocity = { x: -9, y: 1 };

    h.send({
      type: "region.enter",
      regionId: "left-goal",
      tags: ["goal", "leftGoal"],
    }).flush();

    expect(h.state).toMatchObject({ phase: "goal", homeScore: 0, awayScore: 1 });
    expect(h.host.body(h.entityId).mode).toBe("kinematicVelocity");
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 0, y: 0 });

    h.advanceSeconds(defaultSoccerBallConfig.resetSeconds);

    expect(h.state.phase).toBe("playing");
    expect(h.host.body(h.entityId).mode).toBe("dynamic");
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 60, y: 36 });
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 0, y: 0 });
  });

  it("does not count another region event during the same goal", () => {
    const h = harness();
    h.send({ type: "region.enter", regionId: "right-goal", tags: ["goal", "rightGoal"] })
      .send({ type: "region.enter", regionId: "left-goal", tags: ["goal", "leftGoal"] })
      .flush();

    expect(h.state).toMatchObject({ homeScore: 1, awayScore: 0 });
  });

  it("recovers a ball left in a goal when a sleeping room wakes", () => {
    const h = harness();
    h.send({ type: "region.enter", regionId: "right-goal", tags: ["goal", "rightGoal"] })
      .flush()
      .send({ type: "room.wake", fromSnapshot: true })
      .flush();

    expect(h.state).toMatchObject({ phase: "playing", homeScore: 1, awayScore: 0 });
    expect(h.host.body(h.entityId).mode).toBe("dynamic");
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 60, y: 36 });
  });
});
