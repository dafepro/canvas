import type { Vec2 } from "../math/vec2.js";
import type { BodyMode } from "../model/item-definition.js";
import type { Transform } from "../model/item-instance.js";
import type { EntityId } from "../registry/components.js";
import type { ContactParty } from "./events.js";

/** A transient render event produced by an emitEffect command. */
export interface EffectEmission {
  tick: number;
  entityId: EntityId;
  effect: string;
  mode: "oneShot" | "start" | "stop";
  params?: Record<string, number | string | boolean>;
}

/**
 * The simulation side of the behavior boundary. The Rapier world implements it
 * on the host. Tests implement it with a plain object, so behavior logic runs
 * with no physics engine (spec 21.2).
 */
export interface BehaviorHost {
  transform(id: EntityId): Readonly<Transform> | undefined;
  velocity(id: EntityId): Readonly<Vec2> | undefined;
  angularVelocity(id: EntityId): number | undefined;
  elevation(id: EntityId): { z: number; vz: number; grounded: boolean } | undefined;
  contacts(id: EntityId, colliderId: string): readonly ContactParty[];
  tags(id: EntityId): readonly string[];

  applyForce(id: EntityId, force: Vec2, local: boolean): void;
  applyImpulse(id: EntityId, impulse: Vec2, local: boolean): void;
  applyTorque(id: EntityId, torque: number): void;
  setVelocity(id: EntityId, velocity?: Vec2, angularVelocity?: number): void;
  setBodyMode(id: EntityId, mode: BodyMode): void;
  setColliderEnabled(id: EntityId, colliderId: string, enabled: boolean): void;
  setElevationVelocity(id: EntityId, vz: number): void;
  teleport(
    id: EntityId,
    position: Vec2,
    rotation?: number,
    velocity?: Vec2,
    z?: number,
  ): void;
  setSpriteVariant(id: EntityId, variant: string, persistent: boolean): void;
  startAnimation(id: EntityId, animation: string, loop: boolean): void;
  emitEffect(emission: EffectEmission): void;
}
