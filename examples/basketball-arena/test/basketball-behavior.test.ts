import { describe, expect, it } from "vitest";
import {
  BehaviorTestHarness,
  avatarParty,
  runBehaviorConformance,
} from "@canvas-physics/core/testing";
import {
  BasketballBehavior,
  defaultBasketballConfig,
  type BasketballConfig,
  type BasketballState,
} from "../src/basketball-behavior.js";

const harness = () =>
  new BehaviorTestHarness<BasketballConfig, BasketballState>(
    BasketballBehavior,
    defaultBasketballConfig,
    { canvas: { orientation: "topDown", width: 70, height: 42 } },
  );

const score = (
  h: ReturnType<typeof harness>,
  team: "teal" | "coral",
): void => {
  h.send({
    type: "region.enter",
    regionId: `${team}-basket-score`,
    tags: ["basket", team === "teal" ? "tealScores" : "coralScores"],
  }).flush();
};

describe("BasketballBehavior", () => {
  it("passes the public behavior conformance kit", () => {
    const report = runBehaviorConformance(
      BasketballBehavior,
      defaultBasketballConfig,
      {
        harness: { canvas: { orientation: "topDown", width: 70, height: 42 } },
        scenarios: [
          {
            name: "kick, basket, and possession reset",
            exercise: (candidate) => {
              candidate.host.body(candidate.entityId).transform = {
                x: 35,
                y: 21,
                rotation: 0,
              };
              candidate.host.body("avatar-1", { x: 32, y: 21 }).velocity = { x: 8, y: 0 };
              candidate
                .send({
                  type: "contact.enter",
                  selfColliderId: "kick",
                  other: avatarParty("avatar-1"),
                })
                .flush()
                .send({
                  type: "region.enter",
                  regionId: "right-basket-score",
                  tags: ["basket", "tealScores"],
                })
                .flush()
                .advanceSeconds(defaultBasketballConfig.basketResetSeconds);
            },
          },
        ],
      },
    );

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("amplifies avatar motion into a configured ball impulse", () => {
    const h = harness();
    h.host.body(h.entityId).transform = { x: 35, y: 21, rotation: 0 };
    h.host.body("avatar-1", { x: 32, y: 21 }).velocity = { x: 6, y: 0 };

    h.send({
      type: "contact.enter",
      selfColliderId: "kick",
      other: avatarParty("avatar-1"),
    }).flush();

    const [impulse] = h.commands("applyImpulse");
    expect(impulse?.impulse.x).toBeGreaterThan(6);
    expect(h.state.kickCount).toBe(1);
    expect(h.commands("setVelocity")).toHaveLength(1);
  });

  it("keeps the ball live after a basket, then resets possession at centre", () => {
    const h = harness();
    h.host.body(h.entityId).velocity = { x: 12, y: 1 };
    h.host.body(h.entityId).angularVelocity = 5;

    score(h, "teal");

    expect(h.state).toMatchObject({ phase: "basket", tealScore: 2, coralScore: 0 });
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 12, y: 1 });
    expect(h.host.body(h.entityId).mode).toBe("dynamic");

    h.advanceSeconds(defaultBasketballConfig.basketResetSeconds);

    expect(h.state).toMatchObject({ phase: "playing", tealScore: 2, coralScore: 0 });
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 35, y: 21 });
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 0, y: 0 });
    expect(h.host.body(h.entityId).angularVelocity).toBe(0);
  });

  it("resets the entire configured game after a team reaches the winning score", () => {
    const h = harness();

    score(h, "coral");
    h.advanceSeconds(defaultBasketballConfig.basketResetSeconds);
    score(h, "coral");
    h.advanceSeconds(defaultBasketballConfig.basketResetSeconds);
    score(h, "coral");

    expect(h.state).toMatchObject({
      phase: "gameOver",
      tealScore: 0,
      coralScore: defaultBasketballConfig.winningScore,
      winner: "coral",
    });
    expect(h.commands("scheduleTimer").at(-1)).toMatchObject({
      key: "basketball-game-reset",
      seconds: defaultBasketballConfig.gameResetSeconds,
    });

    h.advanceSeconds(defaultBasketballConfig.gameResetSeconds);

    expect(h.state).toMatchObject({ phase: "playing", tealScore: 0, coralScore: 0 });
    expect(h.state.winner).toBeUndefined();
    expect(h.commands("emitEffect").at(-1)).toMatchObject({ effect: "gameReset" });
  });

  it("counts only one basket while a reset is pending", () => {
    const h = harness();
    score(h, "teal");
    score(h, "coral");
    expect(h.state).toMatchObject({ tealScore: 2, coralScore: 0, phase: "basket" });
  });

  it("recovers deterministic reset state when a sleeping room wakes", () => {
    const h = harness();
    score(h, "teal");
    h.send({ type: "room.wake", fromSnapshot: true }).flush();

    expect(h.state).toMatchObject({ phase: "playing", tealScore: 2, coralScore: 0 });
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 35, y: 21 });
  });

  it("centres a live persisted ball when a fresh room host wakes", () => {
    const h = harness();
    h.host.body(h.entityId).transform = { x: 12, y: 31, rotation: 1 };
    h.host.body(h.entityId).velocity = { x: 4, y: -2 };

    h.send({ type: "room.wake", fromSnapshot: true }).flush();

    expect(h.state).toMatchObject({ phase: "playing", tealScore: 0, coralScore: 0 });
    expect(h.host.body(h.entityId).transform).toMatchObject({ x: 35, y: 21, rotation: 0 });
    expect(h.host.body(h.entityId).velocity).toEqual({ x: 0, y: 0 });
  });
});
