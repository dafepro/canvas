import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
  Vec2,
} from "@canvas-physics/core";

export interface LiveBouncerConfig {
  /** Minimum maintained speed; fields and collisions may accelerate above it. */
  speed: number;
  initialDirection: Vec2;
}

export type LiveBouncerState = Record<string, never>;

export const defaultLiveBouncerConfig: LiveBouncerConfig = {
  speed: 8.5,
  initialDirection: { x: 7, y: 5 },
};

/** Keeps the proof ball alive without erasing momentum added by fields. */
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
    if (currentSpeed >= config.speed) {
      return { state: state as LiveBouncerState, commands: [] };
    }
    const source = currentSpeed > 0.001 ? velocity : config.initialDirection;
    const magnitude = Math.max(0.001, Math.hypot(source.x, source.y));
    const missingSpeed = config.speed - currentSpeed;
    return {
      state: state as LiveBouncerState,
      commands: [{
        // An additive impulse composes with field forces authored by another
        // item during the same behavior step; an absolute velocity would erase them.
        type: "applyImpulse",
        impulse: {
          x: (source.x / magnitude) * missingSpeed,
          y: (source.y / magnitude) * missingSpeed,
        },
      }],
    };
  },
};
