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
import { resolveBasketballControlProfile } from "../src/control-profile.js";
import { formatScoreboardScore } from "../src/scoreboard-presentation.js";

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
    for (const geometry of canvas.staticGeometry.filter(({ tags }) =>
      tags?.includes("basketFrame") || tags?.includes("rim")
    )) {
      expect(geometry.blocks).toEqual({ avatars: false, items: true });
    }
    expect(canvas.avatarController).toMatchObject({
      maxSpeed: 19,
      acceleration: 115,
      flickDeceleration: 14,
      facing: "fixed",
      directInteractionMaxSpeed: 12,
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

  it("lets avatars pass beneath basket art while hoop geometry remains item-only", () => {
    const game = simulation();
    game.addAvatar({
      entityId: "avatar:under-hoop",
      clientId: "under-hoop",
      userId: "under-hoop",
      position: { x: 59, y: 21 },
    });

    game.world.setAvatarInput(
      "avatar:under-hoop",
      { x: 1, y: 0 },
      1,
      1,
      true,
      { x: 67, y: 21 },
    );
    game.step();

    expect(game.world.registry.require("avatar:under-hoop").transform.x)
      .toBeCloseTo(67, 4);
    game.free();
  });

  it("turns direct avatar movement into a bounded basketball kick", () => {
    const game = simulation();
    game.addItem(ballInstance(35, 21));
    game.addAvatar({
      entityId: "avatar:drag-kicker",
      clientId: "drag-kicker",
      userId: "drag-kicker",
      position: { x: 28, y: 21 },
    });

    game.world.setAvatarInput(
      "avatar:drag-kicker",
      { x: 1, y: 0 },
      1,
      1,
      true,
      { x: 31.8, y: 21 },
    );
    game.step();
    expect(game.world.contacts("basketball-game-ball", "kick"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ entityId: "avatar:drag-kicker" })]));
    expect(game.world.registry.require("avatar:drag-kicker").transform.x).toBeCloseTo(31.8, 4);
    expect(game.world.velocity("avatar:drag-kicker")!.x).toBe(12);
    expect((game.behaviors.slot("basketball-game-ball")!.state as BasketballState).kickCount)
      .toBeGreaterThan(0);
    for (let tick = 0; tick < 7; tick++) game.step();

    expect((game.behaviors.slot("basketball-game-ball")!.state as BasketballState).kickCount)
      .toBeGreaterThan(0);
    expect(game.world.velocity("basketball-game-ball")!.x).toBeGreaterThan(1);
    game.free();
  });

  it("keeps scoreboard text stable for future high scores", () => {
    expect(formatScoreboardScore(0)).toEqual({ text: "0", characters: 1 });
    expect(formatScoreboardScore(42)).toEqual({ text: "42", characters: 2 });
    expect(formatScoreboardScore(99)).toEqual({ text: "99", characters: 2 });
    expect(formatScoreboardScore(100)).toEqual({ text: "99+", characters: 3 });
  });

  it("offers direct, no-flick, and continuous-velocity control trials", () => {
    expect(resolveBasketballControlProfile(new URLSearchParams()).name).toBe("direct-flick");
    expect(resolveBasketballControlProfile(new URLSearchParams()).pointer.flick)
      .toMatchObject({ minimumSpeedPxPerSecond: 120, fullSpeedPxPerSecond: 700 });
    expect(resolveBasketballControlProfile(new URLSearchParams("flick=0"))).toMatchObject({
      name: "direct-stop",
      pointer: { mode: "avatarDrag", flick: false },
    });
    expect(resolveBasketballControlProfile(new URLSearchParams("control=thumbstick")))
      .toMatchObject({ name: "thumbstick", pointer: { mode: "thumbstick", flick: false } });
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
