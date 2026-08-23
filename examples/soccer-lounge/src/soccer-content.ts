import type { ItemDefinition } from "@canvas-physics/core";
import {
  defaultSoccerBallConfig,
  type SoccerBallConfig,
} from "./soccer-ball-behavior.js";

export const soccerBallDefinition: ItemDefinition<SoccerBallConfig> = {
  definitionId: "soccer-ball",
  version: 5,
  displayName: "Match ball",
  visual: {
    spriteId: "soccer.ball.idle",
    size: { width: 6, height: 6 },
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
      shape: { type: "circle", radius: 3 },
      restitution: 0.9,
      friction: 0.2,
      collisionMask: 0b0000_1100,
    },
    {
      id: "kick",
      role: "itemSensor",
      shape: { type: "circle", radius: 4.2 },
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
  version: 2,
  displayName: "Goal and net",
  visual: {
    spriteId: "soccer.goal.net",
    size: { width: 10, height: 22 },
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

/** Consumer-owned avatar art; Canvas continues to own avatar physics. */
export const soccerAvatarDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "avatar",
  version: 1,
  displayName: "Soccer player",
  visual: {
    spriteId: "soccer.player.avatar",
    size: { width: 4.5, height: 7.5 },
    anchor: { x: 0.5, y: 0.55 },
    placeholder: { shape: "circle", color: 0x23b5a9 },
    zIndex: 10,
  },
  colliders: [],
  defaultConfig: {},
  persistence: {
    transform: false,
    behaviorState: false,
    onRoomSleep: "pause",
  },
  complexity: "simple",
};

export const soccerDefinitions: ItemDefinition[] = [
  soccerBallDefinition as ItemDefinition,
  soccerGoalDefinition as ItemDefinition,
  soccerAvatarDefinition as ItemDefinition,
];

export interface SoccerDisplayOptions {
  /** Disable only the deformation atlas; physical ball rotation remains live. */
  kickAnimation?: boolean;
}

export const soccerDefinitionsForDisplay = (
  options: SoccerDisplayOptions = {},
): ItemDefinition[] => {
  if (options.kickAnimation !== false) return soccerDefinitions;
  return soccerDefinitions.map((definition) =>
    definition.definitionId === soccerBallDefinition.definitionId
      ? {
          ...definition,
          visual: { ...definition.visual, animations: undefined },
        }
      : definition,
  );
};
