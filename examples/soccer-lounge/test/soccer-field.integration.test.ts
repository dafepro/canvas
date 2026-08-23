import { beforeAll, describe, expect, it } from "vitest";
import {
  BehaviorRegistry,
  resolveItemConfig,
  validateCanvasDefinition,
  type CanvasDefinition,
  type ItemDefinition,
  type ItemInstance,
} from "@canvas-physics/core";
import {
  HostSimulation,
  RapierWorld,
  validateAssetReferences,
} from "@canvas-physics/client";
import soccerCanvasJson from "../server/canvases/soccer-lounge.json";
import soccerBallJson from "../server/definitions/soccer-ball.json";
import soccerGoalJson from "../server/definitions/soccer-goal.json";
import { SoccerBallBehavior, type SoccerBallState } from "../src/soccer-ball-behavior.js";
import { soccerBallDefinition, soccerGoalDefinition } from "../src/soccer-content.js";
import { soccerAssets } from "../src/assets.js";

const canvas = soccerCanvasJson as unknown as CanvasDefinition;

beforeAll(async () => {
  await RapierWorld.load();
}, 30_000);

const instance = (x: number, y: number): ItemInstance => ({
  entityId: "match-ball",
  canvasId: canvas.id,
  definitionId: soccerBallDefinition.definitionId,
  definitionVersion: soccerBallDefinition.version,
  ownerUserId: "fixture",
  transform: { x, y, rotation: 0 },
  resolvedConfig: resolveItemConfig(
    soccerBallDefinition as unknown as ItemDefinition<Record<string, unknown>>,
    {
      width: canvas.size.width,
      height: canvas.size.height,
      orientation: canvas.orientation,
    },
  ),
  createdAt: new Date(0).toISOString(),
  sceneRevision: 1,
});

const build = () =>
  new HostSimulation(
    canvas,
    [soccerBallDefinition as ItemDefinition],
    new BehaviorRegistry().register(SoccerBallBehavior),
    60,
  );

describe("soccer field integration", () => {
  it("keeps client content and authoritative server data aligned", () => {
    expect(validateCanvasDefinition(canvas)).toEqual({ ok: true });
    expect(soccerBallJson.defaultConfig).toEqual(soccerBallDefinition.defaultConfig);
    expect(soccerBallJson.behaviorType).toBe(SoccerBallBehavior.behaviorType);
    expect(soccerBallJson.visual).toEqual(soccerBallDefinition.visual);
    expect(soccerGoalJson.visual).toEqual(soccerGoalDefinition.visual);
    expect(
      validateAssetReferences(soccerAssets, canvas, [
        soccerBallDefinition,
        soccerGoalDefinition,
      ]),
    ).toEqual([]);
    expect(
      canvas.systemItems
        .filter(({ definitionId }) => definitionId === soccerGoalDefinition.definitionId)
        .map(({ entityId, transform }) => ({ entityId, ...transform })),
    ).toEqual([
      { entityId: "left-goal", x: 5, y: 36, rotation: 0 },
      { entityId: "right-goal", x: 115, y: 36, rotation: Math.PI },
    ]);
  });

  it("blocks the ball at a touchline", () => {
    const simulation = build();
    simulation.addItem(instance(60, 12));
    simulation.world.setVelocity("match-ball", { x: 0, y: -24 }, 0);

    let minimumY = Number.POSITIVE_INFINITY;
    for (let tick = 0; tick < 180; tick++) {
      simulation.step();
      minimumY = Math.min(
        minimumY,
        simulation.world.registry.require("match-ball").transform.y,
      );
    }

    const ball = simulation.world.registry.require("match-ball");
    expect(minimumY).toBeGreaterThan(6);
    expect(ball.transform.y).toBeGreaterThan(minimumY);
    simulation.free();
  });

  it("scores at the mouth, lets net physics continue, then restarts from centre", () => {
    const simulation = build();
    simulation.addItem(instance(16, 36));
    simulation.world.setVelocity("match-ball", { x: -18, y: 0 }, 0);

    let goalState: SoccerBallState | undefined;
    for (let tick = 0; tick < 180 && !goalState; tick++) {
      simulation.step();
      const state = simulation.behaviors.slot("match-ball")!.state as SoccerBallState;
      if (state.phase === "goal") goalState = state;
    }

    expect(goalState).toMatchObject({ homeScore: 0, awayScore: 1, phase: "goal" });
    const atGoal = simulation.world.registry.require("match-ball");
    expect(atGoal.transform.x).toBeLessThan(10);
    expect(atGoal.rigidBody?.mode).toBe("dynamic");
    const goalX = atGoal.transform.x;
    const goalSpeed = Math.abs(atGoal.rigidBody?.velocity.x ?? 0);

    for (let tick = 0; tick < 30; tick++) simulation.step();
    const inNet = simulation.world.registry.require("match-ball");
    expect(inNet.transform.x).toBeLessThan(goalX);
    expect(inNet.transform.x).toBeGreaterThan(2);
    expect(Math.abs(inNet.rigidBody?.velocity.x ?? 0)).toBeLessThan(goalSpeed);

    for (let tick = 0; tick < 70; tick++) simulation.step();
    const restarted = simulation.world.registry.require("match-ball");
    expect(restarted.transform).toMatchObject({ x: 60, y: 36 });
    expect(simulation.behaviors.slot("match-ball")!.state).toMatchObject({
      phase: "playing",
      awayScore: 1,
    });
    simulation.free();
  });

  it("uses high-damping net zones and explicit goal backstops", () => {
    const simulation = build();
    const fieldDrag = simulation.world.environment.sample({ x: 60, y: 36 }).linearDrag;
    expect(simulation.world.environment.sample({ x: 3, y: 36 }).linearDrag).toBeGreaterThan(
      fieldDrag * 5,
    );
    expect(canvas.staticGeometry.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["left-goal-backstop", "right-goal-backstop"]),
    );
    simulation.free();
  });
});
