import type { ItemDefinition } from "@canvas-physics/core";
import {
  defaultSoccerBallConfig,
  type SoccerBallConfig,
} from "./soccer-ball-behavior.js";

export const soccerBallDefinition: ItemDefinition<SoccerBallConfig> = {
  definitionId: "soccer-ball",
  version: 1,
  displayName: "Match ball",
  visual: {
    size: { width: 2.6, height: 2.6 },
    placeholder: { shape: "circle", color: 0xf7f4e9 },
    zIndex: 6,
    variants: {
      goal: { color: 0xffd166 },
    },
  },
  body: {
    mode: "dynamic",
    mass: 0.45,
    gravityScale: 0,
    linearDamping: 0.35,
    angularDamping: 0.6,
    canSleep: true,
  },
  colliders: [
    {
      id: "solid",
      role: "itemSolid",
      shape: { type: "circle", radius: 1.3 },
      restitution: 0.72,
      friction: 0.35,
      collisionMask: 0b0000_1100,
    },
    {
      id: "kick",
      role: "itemSensor",
      shape: { type: "circle", radius: 2.2 },
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

export const soccerDefinitions: ItemDefinition[] = [
  soccerBallDefinition as ItemDefinition,
];
