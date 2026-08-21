import type { Vec2 } from "../math/vec2.js";
import type { EntityId } from "../registry/components.js";

/** Identifies the other side of a contact. */
export interface ContactParty {
  entityId: EntityId;
  colliderId: string;
  kind: "avatar" | "item" | "static" | "region";
  tags: string[];
  /** Present for avatar parties. */
  userId?: string;
}

interface BaseEvent {
  /** Simulation tick on which the host produced the event. */
  tick: number;
  /** The entity whose behavior receives the event. */
  self: EntityId;
  /** Collider of `self` involved in the event, when one applies. */
  selfColliderId?: string;
}

export interface ContactEnterEvent extends BaseEvent {
  type: "contact.enter";
  other: ContactParty;
}

export interface ContactStayEvent extends BaseEvent {
  type: "contact.stay";
  other: ContactParty;
  /** Simulation ticks the contact has lasted. */
  dwellTicks: number;
}

export interface ContactExitEvent extends BaseEvent {
  type: "contact.exit";
  other: ContactParty;
  dwellTicks: number;
}

/** Spec 8.3. Fires when the qualifying contact set of a collider changes. */
export interface ContactCountEvent extends BaseEvent {
  type: "contact.count";
  colliderId: string;
  count: number;
  previousCount: number;
  parties: ContactParty[];
}

export interface BounceEvent extends BaseEvent {
  type: "bounce";
  other: ContactParty;
  normal: Vec2;
  relativeSpeed: number;
}

export interface ImpulseEvent extends BaseEvent {
  type: "impulse";
  source: "avatarKick" | "behavior" | "portal" | "landing";
  impulse: Vec2;
  other?: ContactParty;
}

export interface RegionEnterEvent extends BaseEvent {
  type: "region.enter";
  regionId: string;
  tags: string[];
}

export interface RegionExitEvent extends BaseEvent {
  type: "region.exit";
  regionId: string;
  tags: string[];
  /** Motion direction on exit, so a behavior can tell rising from falling. */
  velocity: Vec2;
}

export interface TimerEvent extends BaseEvent {
  type: "timer";
  timerId: string;
  key: string;
  /** Ticks the timer ran for. */
  elapsedTicks: number;
}

export interface OwnerActionEvent extends BaseEvent {
  type: "owner.action";
  action: string;
  userId: string;
  payload?: unknown;
}

export interface RoomWakeEvent extends BaseEvent {
  type: "room.wake";
  /** True when the durable state came from a sleeping room checkpoint. */
  fromSnapshot: boolean;
}

/** Spec 4.3. Emitted when the elevation channel returns to the ground plane. */
export interface LandingEvent extends BaseEvent {
  type: "landing";
  impactSpeed: number;
}

export interface TickEvent extends BaseEvent {
  type: "tick";
  /** Fixed step duration in seconds. */
  dt: number;
}

export type BehaviorEvent =
  | ContactEnterEvent
  | ContactStayEvent
  | ContactExitEvent
  | ContactCountEvent
  | BounceEvent
  | ImpulseEvent
  | RegionEnterEvent
  | RegionExitEvent
  | TimerEvent
  | OwnerActionEvent
  | RoomWakeEvent
  | LandingEvent
  | TickEvent;

export type BehaviorEventType = BehaviorEvent["type"];

/**
 * Stable processing order inside one tick (spec 8.4). Lower runs first. Contact
 * exits run before enters so a behavior sees a clean set before new parties.
 */
export const eventOrder: Record<BehaviorEventType, number> = {
  "room.wake": 0,
  "region.exit": 1,
  "contact.exit": 2,
  "contact.enter": 3,
  "region.enter": 4,
  "contact.stay": 5,
  "contact.count": 6,
  bounce: 7,
  impulse: 8,
  landing: 9,
  timer: 10,
  "owner.action": 11,
  tick: 12,
};

/** Sorts events into the canonical processing order for one tick. */
export const sortEvents = <T extends BehaviorEvent>(events: T[]): T[] =>
  events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        eventOrder[a.event.type] - eventOrder[b.event.type] || a.index - b.index,
    )
    .map(({ event }) => event);
