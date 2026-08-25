import type { Vec2 } from "../math/vec2.js";
import type {
  BodyMode,
  ColliderDefinition,
  ElevationDefinition,
} from "../model/item-definition.js";
import type { Transform } from "../model/item-instance.js";

export type EntityId = string;

export interface RenderComponent {
  definitionId: string;
  definitionVersion?: number;
  variant?: string;
  tint?: number;
  animation?: string;
  /** Rises whenever an animation starts, including replaying the same name. */
  animationEpoch?: number;
  zIndex: number;
  size: { width: number; height: number };
}

export interface RigidBodyComponent {
  mode: BodyMode;
  velocity: Vec2;
  angularVelocity: number;
  gravityScale: number;
  mass: number;
  awake: boolean;
}

export interface ColliderComponent extends ColliderDefinition {
  /** Physics engine handle, set by the simulation layer only. */
  handle?: number;
}

export interface AvatarComponent {
  userId: string;
  clientId: string;
  radius: number;
  maxSpeed: number;
  acceleration: number;
  flickDeceleration: number;
  maxTurnSpeed: number;
  facing: "movement" | "fixed";
  directInteractionMaxSpeed: number;
  /** Host-tick velocity used by contact behaviors for direct pointer movement. */
  interactionVelocity: Vec2;
  /** True while a one-shot direct-control flick is coasting to rest. */
  flicking: boolean;
  /** Newest input sequence the host applied for this avatar. */
  lastProcessedInputSeq: number;
  desiredDirection: Vec2;
  desiredIntensity: number;
  /** Absolute world target while the avatar is held by direct pointer input. */
  desiredPosition?: Vec2;
  /**
   * Addendum A1. True when no physics act on this avatar. The avatar keeps its
   * position, its identity, and its ownership, but it does not move, it does
   * not collide, and it emits no contact event.
   */
  disabled?: boolean;
}

export interface ElevationComponent extends ElevationDefinition {
  z: number;
  vz: number;
  grounded: boolean;
}

export interface BehaviorComponent {
  behaviorType: string;
  config: unknown;
  state: unknown;
  stateVersion: number;
  /** Set true when the definition declares behaviorState durable. */
  persistent: boolean;
}

export interface OwnershipComponent {
  ownerUserId: string;
  itemRevision: number;
  editLockedBy?: string;
}

export interface PersistenceComponent {
  transform: boolean;
  behaviorState: boolean;
  onRoomSleep: "resetToIdle" | "pause";
}

/**
 * Spec 15.3. A composition model, not a full ECS framework. Avoid deep class
 * inheritance such as Rocket extends PhysicsItem extends Item.
 */
export interface Entity {
  id: EntityId;
  kind: "avatar" | "item" | "static" | "region";
  transform: Transform;
  render?: RenderComponent;
  rigidBody?: RigidBodyComponent;
  colliders?: ColliderComponent[];
  avatar?: AvatarComponent;
  elevation?: ElevationComponent;
  behavior?: BehaviorComponent;
  ownership?: OwnershipComponent;
  /** True while this item is excluded from physics, collision, and behavior. */
  isolated?: boolean;
  /** Global owner control over this item's authored colliders. */
  collisionsDisabled?: boolean;
  persistence?: PersistenceComponent;
  tags?: Set<string>;
  /** Set by the host when a NaN or out-of-bounds value is found (spec 14.3). */
  quarantined?: boolean;
  /**
   * Addendum A3. True while the body waits out its respawn delay. It is not
   * drawn, it holds no active collider, and no force acts on it.
   */
  respawning?: boolean;
  /**
   * Addendum A2. Rises on every discontinuous move, such as an edge wrap or a
   * respawn. A renderer that sees a new value snaps instead of interpolating.
   */
  teleportEpoch?: number;
}
