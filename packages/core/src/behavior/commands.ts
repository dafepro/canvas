import type { Vec2 } from "../math/vec2.js";
import type { BodyMode } from "../model/item-definition.js";
import type { EntityId } from "../registry/components.js";

/**
 * Commands are the only way a behavior changes the world (spec 8.1). The
 * runtime applies them after event handling, never during it (spec 8.4).
 */

export interface ApplyForce {
  type: "applyForce";
  target?: EntityId;
  force: Vec2;
  /** Apply along the entity forward vector instead of world axes. */
  local?: boolean;
}

export interface ApplyImpulse {
  type: "applyImpulse";
  target?: EntityId;
  impulse: Vec2;
  local?: boolean;
}

export interface ApplyTorque {
  type: "applyTorque";
  target?: EntityId;
  torque: number;
}

export interface SetVelocity {
  type: "setVelocity";
  target?: EntityId;
  velocity?: Vec2;
  angularVelocity?: number;
}

export interface SetBodyMode {
  type: "setBodyMode";
  target?: EntityId;
  mode: BodyMode;
}

export interface SetColliderEnabled {
  type: "setColliderEnabled";
  target?: EntityId;
  colliderId: string;
  enabled: boolean;
}

export interface SetSpriteVariant {
  type: "setSpriteVariant";
  target?: EntityId;
  variant: string;
  /** Persist the variant in the durable snapshot (spec 13.1). */
  persistent?: boolean;
}

export interface StartAnimation {
  type: "startAnimation";
  target?: EntityId;
  animation: string;
  loop?: boolean;
}

/** Transient visual or audio event. Never persisted (spec 2.1). */
export interface EmitEffect {
  type: "emitEffect";
  target?: EntityId;
  effect: string;
  /** Serializable payload for the renderer effect system. */
  params?: Record<string, number | string | boolean>;
  /** "start" and "stop" model a continuous effect such as a thrust trail. */
  mode?: "oneShot" | "start" | "stop";
}

export interface Teleport {
  type: "teleport";
  target?: EntityId;
  position: Vec2;
  rotation?: number;
  velocity?: Vec2;
  z?: number;
}

export interface SetElevationVelocity {
  type: "setElevationVelocity";
  target?: EntityId;
  vz: number;
}

export interface ScheduleTimer {
  type: "scheduleTimer";
  key: string;
  /** Duration in seconds, converted to simulation ticks by the runtime. */
  seconds: number;
  /** Replace an existing timer with the same key. Default true. */
  replace?: boolean;
}

export interface CancelTimer {
  type: "cancelTimer";
  key: string;
}

export interface SetState {
  type: "setState";
  state: unknown;
}

export interface LogCommand {
  type: "log";
  message: string;
  data?: Record<string, unknown>;
}

export type BehaviorCommand =
  | ApplyForce
  | ApplyImpulse
  | ApplyTorque
  | SetVelocity
  | SetBodyMode
  | SetColliderEnabled
  | SetSpriteVariant
  | StartAnimation
  | EmitEffect
  | Teleport
  | SetElevationVelocity
  | ScheduleTimer
  | CancelTimer
  | SetState
  | LogCommand;

export type BehaviorCommandType = BehaviorCommand["type"];

/**
 * Commands that change simulation state and must be applied before the next
 * physics step. The rest are render or bookkeeping commands.
 */
export const simulationCommands: ReadonlySet<BehaviorCommandType> = new Set([
  "applyForce",
  "applyImpulse",
  "applyTorque",
  "setVelocity",
  "setBodyMode",
  "setColliderEnabled",
  "teleport",
  "setElevationVelocity",
]);
