import { describe, expect, it } from "vitest";
import {
  BehaviorTestHarness,
  avatarParty,
  runBehaviorConformance,
} from "@canvas-physics/core/testing";
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
  it("passes the public external-behavior conformance kit", () => {
    const report = runBehaviorConformance(
      SoccerBallBehavior,
      defaultSoccerBallConfig,
      {
        harness: { canvas: { orientation: "topDown", width: 120, height: 80 } },
        scenarios: [
          {
            name: "kick and score",
            exercise: (candidate) => {
              candidate.host.body(candidate.entityId).transform = {
                x: 50,
                y: 40,
                rotation: 0,
              };
              candidate.host.body("avatar-1", { x: 47, y: 40 }).velocity = { x: 8, y: 0 };
              candidate
                .send({
                  type: "contact.enter",
                  selfColliderId: "kick",
                  other: avatarParty("avatar-1"),
                })
                .flush()
                .send({
                  type: "region.enter",
                  regionId: "right-goal",
                  tags: ["goal", "rightGoal"],
                })
                .flush()
                .advanceSeconds(defaultSoccerBallConfig.resetSeconds);
            },
          },
        ],
      },
    );

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

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
    expect(h.commands("startAnimation")).toEqual([
      { type: "startAnimation", animation: "hardKick", loop: false },
    ]);
    expect(h.host.body(h.entityId).velocity.x).toBeGreaterThan(0);
  });

  it("turns a glancing kick into lateral motion and matching clockwise spin", () => {
    const h = harness();
    h.host.body(h.entityId).transform = { x: 50, y: 40, rotation: 0 };
    h.host.body("avatar-1", { x: 50, y: 37 }).velocity = { x: 6, y: 8 };

    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();

    const [impulse] = h.commands("applyImpulse");
    expect(impulse?.impulse.x).toBeGreaterThan(0);
    expect(impulse?.impulse.y).toBeGreaterThan(0);
    expect(h.commands("setVelocity")).toEqual([
      expect.objectContaining({ angularVelocity: expect.any(Number) }),
    ]);
    expect(h.host.body(h.entityId).angularVelocity).toBeGreaterThan(0);
  });

  it("reverses spin for the mirrored glancing kick and caps angular speed", () => {
    const h = harness();
    h.host.body(h.entityId).transform = { x: 50, y: 40, rotation: 0 };
    h.host.body(h.entityId).angularVelocity = -defaultSoccerBallConfig.maxAngularSpeed + 0.1;
    h.host.body("avatar-1", { x: 50, y: 43 }).velocity = { x: 20, y: -8 };

    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();

    expect(h.host.body(h.entityId).angularVelocity).toBe(
      -defaultSoccerBallConfig.maxAngularSpeed,
    );
  });

  it("scores for away while physics continues, then resets at centre", () => {
    const h = harness();
    h.host.body(h.entityId).velocity = { x: -9, y: 1 };
    h.host.body(h.entityId).angularVelocity = 7;

    h.send({
      type: "region.enter",
      regionId: "left-goal",
      tags: ["goal", "leftGoal"],
    }).flush();

    expect(h.state).toMatchObject({ phase: "goal", homeScore: 0, awayScore: 1 });
    expect(h.host.body(h.entityId).mode).toBe("dynamic");
    expect(h.host.body(h.entityId).velocity).toEqual({ x: -9, y: 1 });

    h.advanceSeconds(defaultSoccerBallConfig.resetSeconds);

    expect(h.state.phase).toBe("playing");
    expect(h.host.body(h.entityId).mode).toBe("dynamic");
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 60, y: 36 });
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 0, y: 0 });
    expect(h.host.body(h.entityId).angularVelocity).toBe(0);
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
