import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
  Vec2,
} from "@canvas-physics/core";

export interface LiveBouncerConfig {
  minimumSpeed: number;
  velocity: Vec2;
}

export interface LiveBouncerState {
  launches: number;
}

export const defaultLiveBouncerConfig: LiveBouncerConfig = {
  minimumSpeed: 3,
  velocity: { x: 7, y: 5 },
};

/** A tiny consumer behavior used to prove simulation continues during editing. */
export const LiveBouncerBehavior: ItemBehavior<
  LiveBouncerConfig,
  LiveBouncerState
> = {
  behaviorType: "liveBouncer",
  stateVersion: 1,
  subscribes: ["tick", "room.wake"],
  initialState: () => ({ launches: 0 }),
  onEvent(
    ctx: BehaviorContext,
    config: LiveBouncerConfig,
    state: Readonly<LiveBouncerState>,
    _event: BehaviorEvent,
  ): BehaviorResult<LiveBouncerState> {
    const velocity = ctx.velocity() ?? { x: 0, y: 0 };
    if (Math.hypot(velocity.x, velocity.y) >= config.minimumSpeed) {
      return { state: state as LiveBouncerState, commands: [] };
    }
    return {
      state: { launches: state.launches + 1 },
      commands: [{ type: "setVelocity", velocity: config.velocity }],
    };
  },
};
