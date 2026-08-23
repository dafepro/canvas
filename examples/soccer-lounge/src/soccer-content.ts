import type { ItemDefinition } from "@canvas-physics/core";
import {
  defaultSoccerBallConfig,
  type SoccerBallConfig,
} from "./soccer-ball-behavior.js";

export const soccerBallDefinition: ItemDefinition<SoccerBallConfig> = {
  definitionId: "soccer-ball",
  version: 2,
  displayName: "Match ball",
  visual: {
    spriteId: "soccer.ball.idle",
    size: { width: 3.3, height: 3.3 },
    placeholder: { shape: "circle", color: 0xf7f4e9 },
    zIndex: 6,
    variants: {
      goal: { color: 0xffd166 },
    },
    animations: {
      hardKick: {
        frames: [
          "soccer.ball.idle",
          "soccer.ball.impact",
          "soccer.ball.stretch",
          "soccer.ball.settle",
          "soccer.ball.idle",
        ],
        fps: 18,
        loop: false,
      },
    },
  },
  body: {
    mode: "dynamic",
    mass: 0.45,
    gravityScale: 0,
    linearDamping: 0.15,
    angularDamping: 0.35,
    canSleep: true,
  },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.65 },
      restitution: 0.9,
      friction: 0.2,
      collisionMask: 0b0000_1100,
    },
    {
      id: "kick",
      role: "itemSensor",
      shape: { type: "circle", radius: 2.55 },
    },
  ],
  behaviorType: "soccerBall",
  defaultConfig: defaultSoccerBallConfig,
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

/** Decorative room-owned goal. Collision stays in the canvas definition. */
export const soccerGoalDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "soccer-goal",
  version: 1,
  displayName: "Goal and net",
  visual: {
    spriteId: "soccer.goal.net",
    size: { width: 9, height: 14 },
    anchor: { x: 0.5, y: 0.5 },
    zIndex: 3,
  },
  body: {
    mode: "fixed",
    gravityScale: 0,
    lockRotation: true,
  },
  colliders: [],
  defaultConfig: {},
  persistence: {
    transform: true,
    behaviorState: false,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const soccerDefinitions: ItemDefinition[] = [
  soccerBallDefinition as ItemDefinition,
  soccerGoalDefinition as ItemDefinition,
];
