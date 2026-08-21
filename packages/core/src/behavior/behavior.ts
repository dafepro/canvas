import type { Vec2 } from "../math/vec2.js";
import type { CanvasOrientation } from "../model/canvas-definition.js";
import type { Transform } from "../model/item-instance.js";
import type { MigrationChain } from "../model/versioning.js";
import type { EntityId } from "../registry/components.js";
import type { BehaviorCommand } from "./commands.js";
import type { BehaviorEvent, ContactParty } from "./events.js";

/** Read-only view the runtime gives to a behavior. No renderer, no transport. */
export interface BehaviorContext {
  readonly tick: number;
  readonly tickRate: number;
  /** Fixed step duration in seconds. */
  readonly dt: number;
  readonly self: EntityId;
  readonly canvas: {
    id: string;
    width: number;
    height: number;
    orientation: CanvasOrientation;
  };
  transform(target?: EntityId): Readonly<Transform> | undefined;
  velocity(target?: EntityId): Readonly<Vec2> | undefined;
  angularVelocity(target?: EntityId): number | undefined;
  elevation(target?: EntityId): { z: number; vz: number; grounded: boolean } | undefined;
  /** Current contact set of one collider of `self`. */
  contacts(colliderId: string): readonly ContactParty[];
  tags(target?: EntityId): readonly string[];
  /** Seconds converted to whole simulation ticks. */
  ticksFor(seconds: number): number;
  /** Deterministic pseudo-random number in [0, 1). Seeded per entity and tick. */
  random(): number;
}

export interface BehaviorResult<State> {
  state: State;
  commands: BehaviorCommand[];
}

/** Spec 8.2. */
export interface ItemBehavior<Config = unknown, State = unknown> {
  readonly behaviorType: string;
  /** Version of the persisted state shape. */
  readonly stateVersion: number;
  /** Required when stateVersion is greater than 1 and state is durable. */
  readonly migrations?: MigrationChain<State>;
  initialState(config: Config): State;
  onEvent(
    ctx: BehaviorContext,
    config: Config,
    state: Readonly<State>,
    event: BehaviorEvent,
  ): BehaviorResult<State>;
  /**
   * Spec 13.3. Called when the room sleeps and the item declares
   * onRoomSleep: "resetToIdle". Return the durable state to persist.
   */
  normalizeForSleep?(config: Config, state: Readonly<State>): State;
  /** Event types this behavior wants. Omit to receive every event. */
  readonly subscribes?: readonly BehaviorEvent["type"][];
}

/** Helper for a behavior that returns no commands. */
export const stateOnly = <State>(state: State): BehaviorResult<State> => ({
  state,
  commands: [],
});

export const noChange = <State>(state: Readonly<State>): BehaviorResult<State> => ({
  state: state as State,
  commands: [],
});
