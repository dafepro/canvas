import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BehaviorRegistry,
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
import canvasJson from "../server/canvases/basketball-arena.json";
import avatarJson from "../server/definitions/avatar.json";
import ballJson from "../server/definitions/basketball-game-ball.json";
import hoopJson from "../server/definitions/basketball-hoop.json";
import mirroredHoopJson from "../server/definitions/basketball-hoop-mirrored.json";
import tealScoreboardJson from "../server/definitions/basketball-scoreboard-teal.json";
import coralScoreboardJson from "../server/definitions/basketball-scoreboard-coral.json";
import { basketballAssets } from "../src/assets.js";
import {
  BasketballBehavior,
  type BasketballState,
} from "../src/basketball-behavior.js";
import {
  basketballAvatarDefinition,
  basketballBallDefinition,
  basketballCanvas,
  basketballCoralScoreboardDefinition,
  basketballHoopDefinition,
  basketballMirroredHoopDefinition,
  basketballTealScoreboardDefinition,
} from "../src/basketball-content.js";

const canvas = canvasJson as unknown as CanvasDefinition;
const root = resolve(import.meta.dirname, "..");

beforeAll(async () => {
  await RapierWorld.load();
}, 30_000);

const ballInstance = (x: number, y: number): ItemInstance => ({
  entityId: "basketball-game-ball",
  canvasId: canvas.id,
  definitionId: basketballBallDefinition.definitionId,
  definitionVersion: basketballBallDefinition.version,
  ownerUserId: "",
  transform: { x, y, rotation: 0, scale: 1 },
  resolvedConfig: basketballBallDefinition.defaultConfig,
  createdAt: new Date(0).toISOString(),
  sceneRevision: 1,
});

const simulation = () =>
  new HostSimulation(
    canvas,
    [basketballBallDefinition as ItemDefinition],
    new BehaviorRegistry().register(BasketballBehavior),
    60,
  );

describe("basketball arena integration", () => {
  it("keeps browser definitions and authoritative server JSON identical", () => {
    expect(canvasJson).toEqual(basketballCanvas);
    expect(ballJson).toMatchObject(basketballBallDefinition);
    expect(hoopJson).toMatchObject(basketballHoopDefinition);
    expect(mirroredHoopJson).toMatchObject(basketballMirroredHoopDefinition);
    expect(tealScoreboardJson).toMatchObject(basketballTealScoreboardDefinition);
    expect(coralScoreboardJson).toMatchObject(basketballCoralScoreboardDefinition);
    expect(avatarJson).toMatchObject(basketballAvatarDefinition);
    expect(validateCanvasDefinition(canvas)).toEqual({ ok: true });
    expect(
      validateAssetReferences(basketballAssets, canvas, [
        basketballBallDefinition,
        basketballHoopDefinition,
        basketballMirroredHoopDefinition,
        basketballTealScoreboardDefinition,
        basketballCoralScoreboardDefinition,
        basketballAvatarDefinition,
      ]),
    ).toEqual([]);
  });

  it("puts scoring, resets, geometry, and game length in configuration", () => {
    const config = basketballBallDefinition.defaultConfig;
    expect(config).toMatchObject({
      pointsPerBasket: 2,
      winningScore: 6,
      basketResetSeconds: 1.25,
      gameResetSeconds: 3,
      centre: { x: 35, y: 21 },
      tealScoreTag: "tealScores",
      coralScoreTag: "coralScores",
    });
    expect(canvas.regions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "left-basket-score",
        shape: { type: "circle", x: 7.8, y: 21, radius: 1.45 },
        tags: ["basket", "coralScores"],
      }),
      expect.objectContaining({
        id: "right-basket-score",
        shape: { type: "circle", x: 62.2, y: 21, radius: 1.45 },
        tags: ["basket", "tealScores"],
      }),
    ]));
    expect(canvas.staticGeometry.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "left-backboard",
      "right-backboard",
      "left-rim-18.9",
      "right-rim-23.1",
    ]));
    expect(canvas.avatarController).toMatchObject({
      maxSpeed: 19,
      acceleration: 115,
      flickDeceleration: 14,
      maxTurnSpeed: 7,
    });
    expect(canvas.systemItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: "right-basketball-hoop",
        definitionId: "basketball-hoop-mirrored",
        transform: expect.objectContaining({ rotation: 0 }),
      }),
      expect.objectContaining({ entityId: "teal-scoreboard" }),
      expect.objectContaining({ entityId: "coral-scoreboard" }),
    ]));
  });

  it("scores through configured hoop geometry while physics remains live", () => {
    const game = simulation();
    game.addItem(ballInstance(55, 21));
    game.world.setVelocity("basketball-game-ball", { x: 20, y: 0 }, 3);

    let scoredAtX: number | undefined;
    let scoreState: BasketballState | undefined;
    for (let tick = 0; tick < 180 && !scoreState; tick++) {
      game.step();
      const state = game.behaviors.slot("basketball-game-ball")!.state as BasketballState;
      if (state.phase === "basket") {
        scoreState = state;
        scoredAtX = game.world.registry.require("basketball-game-ball").transform.x;
      }
    }

    expect(scoreState).toMatchObject({ phase: "basket", tealScore: 2, coralScore: 0 });
    expect(scoredAtX).toBeGreaterThan(60);
    expect(game.world.registry.require("basketball-game-ball").rigidBody?.mode)
      .toBe("dynamic");

    for (let tick = 0; tick < 90; tick++) game.step();
    expect(game.world.registry.require("basketball-game-ball").transform)
      .toMatchObject({ x: 35, y: 21 });
    expect(game.behaviors.slot("basketball-game-ball")!.state)
      .toMatchObject({ phase: "playing", tealScore: 2 });
    game.free();
  });

  it("uses generated art for the complete court, ball, hoops, avatar, and UI", () => {
    for (const file of [
      "basketball-court.png",
      "basketball-ball.png",
      "basketball-hoop.png",
      "basketball-avatar.png",
      "basketball-scoreboard.png",
    ]) {
      expect(readFileSync(resolve(root, `public/assets/${file}`)).byteLength)
        .toBeGreaterThan(500_000);
    }
  });
});
