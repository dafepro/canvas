import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
  Vec2,
} from "@canvas-physics/core";

export interface LiveBouncerConfig {
  speed: number;
  initialDirection: Vec2;
}

export type LiveBouncerState = Record<string, never>;

export const defaultLiveBouncerConfig: LiveBouncerConfig = {
  speed: 8.5,
  initialDirection: { x: 7, y: 5 },
};

/** A tiny consumer behavior used to prove simulation continues during editing. */
export const LiveBouncerBehavior: ItemBehavior<
  LiveBouncerConfig,
  LiveBouncerState
> = {
  behaviorType: "liveBouncer",
  stateVersion: 1,
  subscribes: ["tick", "room.wake"],
  initialState: () => ({}),
  onEvent(
    ctx: BehaviorContext,
    config: LiveBouncerConfig,
    state: Readonly<LiveBouncerState>,
    _event: BehaviorEvent,
  ): BehaviorResult<LiveBouncerState> {
    const velocity = ctx.velocity() ?? { x: 0, y: 0 };
    const currentSpeed = Math.hypot(velocity.x, velocity.y);
    if (Math.abs(currentSpeed - config.speed) < 0.01) {
      return { state: state as LiveBouncerState, commands: [] };
    }
    const source = currentSpeed > 0.001 ? velocity : config.initialDirection;
    const magnitude = Math.max(0.001, Math.hypot(source.x, source.y));
    return {
      state: state as LiveBouncerState,
      commands: [{
        type: "setVelocity",
        velocity: {
          x: (source.x / magnitude) * config.speed,
          y: (source.y / magnitude) * config.speed,
        },
      }],
    };
  },
};
