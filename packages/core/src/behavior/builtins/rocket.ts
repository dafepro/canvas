import type { BehaviorContext, BehaviorResult, ItemBehavior } from "../behavior.js";
import type { BehaviorCommand } from "../commands.js";
import type { BehaviorEvent } from "../events.js";

/** Spec 8.5. Every value is data, so the same behavior fits several canvases. */
export interface RocketConfig {
  /** Sensor collider that arms the rocket when avatars touch it. */
  armSensorId: string;
  requiredContacts: number;
  countdownSeconds: number;
  /** Time without a qualifying contact before the rocket disarms. */
  graceSeconds: number;
  launchImpulse: number;
  thrust: number;
  thrustSeconds: number;
  maxSpeed: number;
  /** Region tag that puts the rocket into space drift. */
  spaceRegionTag: string;
  /** Static geometry tag that counts as ground. */
  groundTag: string;
  landingSpeedThreshold: number;
  cooldownSeconds: number;
}

export const defaultRocketConfig: RocketConfig = {
  armSensorId: "arm",
  requiredContacts: 1,
  countdownSeconds: 3,
  graceSeconds: 0.75,
  launchImpulse: 12,
  thrust: 24,
  thrustSeconds: 1.5,
  maxSpeed: 19,
  spaceRegionTag: "space",
  groundTag: "ground",
  landingSpeedThreshold: 4,
  cooldownSeconds: 1.5,
};

export type RocketPhase =
  | "idle"
  | "arming"
  | "flying"
  | "spaceDrift"
  | "falling"
  | "landed";

export interface RocketState {
  phase: RocketPhase;
  /** Tick the countdown started on. Clients derive the overlay from it. */
  armedAtTick: number;
  countdownTicks: number;
  qualifyingContacts: number;
  thrustTicksRemaining: number;
  launchCount: number;
}

const initial: RocketState = {
  phase: "idle",
  armedAtTick: 0,
  countdownTicks: 0,
  qualifyingContacts: 0,
  thrustTicksRemaining: 0,
  launchCount: 0,
};

const enterPhase = (
  state: RocketState,
  phase: RocketPhase,
  commands: BehaviorCommand[],
): BehaviorResult<RocketState> => ({
  state: { ...state, phase },
  commands: [{ type: "setSpriteVariant", variant: phase }, ...commands],
});

export const RocketBehavior: ItemBehavior<RocketConfig, RocketState> = {
  behaviorType: "rocket",
  stateVersion: 1,

  initialState: () => ({ ...initial }),

  normalizeForSleep: (_config, state) => ({
    ...initial,
    launchCount: state.launchCount,
  }),

  onEvent(
    ctx: BehaviorContext,
    config: RocketConfig,
    state: Readonly<RocketState>,
    event: BehaviorEvent,
  ): BehaviorResult<RocketState> {
    switch (event.type) {
      case "room.wake":
        return enterPhase({ ...state, ...initial, launchCount: state.launchCount }, "idle", [
          { type: "emitEffect", effect: "countdown", mode: "stop" },
          { type: "emitEffect", effect: "thrustTrail", mode: "stop" },
        ]);

      case "contact.count": {
        if (event.colliderId !== config.armSensorId) return { state, commands: [] };
        const next = { ...state, qualifyingContacts: event.count };
        const qualified = event.count >= config.requiredContacts;

        if (state.phase === "idle" && qualified) {
          return enterPhase(
            { ...next, armedAtTick: ctx.tick, countdownTicks: ctx.ticksFor(config.countdownSeconds) },
            "arming",
            [
              { type: "scheduleTimer", key: "countdown", seconds: config.countdownSeconds },
              {
                type: "emitEffect",
                effect: "countdown",
                mode: "start",
                params: { seconds: config.countdownSeconds },
              },
            ],
          );
        }
        if (state.phase === "arming" && !qualified) {
          return {
            state: next,
            commands: [{ type: "scheduleTimer", key: "grace", seconds: config.graceSeconds }],
          };
        }
        if (state.phase === "arming" && qualified) {
          return { state: next, commands: [{ type: "cancelTimer", key: "grace" }] };
        }
        return { state: next, commands: [] };
      }

      case "timer": {
        if (event.key === "countdown" && state.phase === "arming") {
          return enterPhase(
            {
              ...state,
              thrustTicksRemaining: ctx.ticksFor(config.thrustSeconds),
              launchCount: state.launchCount + 1,
            },
            "flying",
            [
              // Local frame: the nose points along negative Y at rotation 0.
              { type: "applyImpulse", impulse: { x: 0, y: -config.launchImpulse }, local: true },
              { type: "emitEffect", effect: "countdown", mode: "stop" },
              { type: "emitEffect", effect: "thrustTrail", mode: "start" },
              { type: "startAnimation", animation: "launch", loop: false },
            ],
          );
        }
        if (event.key === "grace" && state.phase === "arming") {
          return enterPhase(state, "idle", [
            { type: "cancelTimer", key: "countdown" },
            { type: "emitEffect", effect: "countdown", mode: "stop" },
          ]);
        }
        if (event.key === "cooldown" && state.phase === "landed") {
          return enterPhase({ ...state, ...initial, launchCount: state.launchCount }, "idle", []);
        }
        return { state, commands: [] };
      }

      case "tick": {
        if (state.phase !== "flying" || state.thrustTicksRemaining <= 0) {
          return { state, commands: [] };
        }
        const commands: BehaviorCommand[] = [
          { type: "applyForce", force: { x: 0, y: -config.thrust }, local: true },
        ];
        if (state.thrustTicksRemaining === 1) {
          commands.push({ type: "emitEffect", effect: "thrustTrail", mode: "stop" });
        }
        return {
          state: { ...state, thrustTicksRemaining: state.thrustTicksRemaining - 1 },
          commands,
        };
      }

      case "region.enter":
        if (
          event.tags.includes(config.spaceRegionTag) &&
          (state.phase === "flying" || state.phase === "falling")
        ) {
          return enterPhase(state, "spaceDrift", [
            { type: "emitEffect", effect: "spaceSparkle", mode: "start" },
          ]);
        }
        return { state, commands: [] };

      case "region.exit":
        // Y increases downward, so a positive Y velocity means falling.
        if (
          event.tags.includes(config.spaceRegionTag) &&
          state.phase === "spaceDrift" &&
          event.velocity.y > 0
        ) {
          return enterPhase(state, "falling", [
            { type: "emitEffect", effect: "spaceSparkle", mode: "stop" },
          ]);
        }
        return { state, commands: [] };

      case "contact.enter": {
        const onGround = event.other.tags.includes(config.groundTag);
        const airborne =
          state.phase === "flying" || state.phase === "falling" || state.phase === "spaceDrift";
        if (!onGround || !airborne) return { state, commands: [] };
        const speed = Math.hypot(
          ctx.velocity()?.x ?? 0,
          ctx.velocity()?.y ?? 0,
        );
        if (speed > config.landingSpeedThreshold) {
          return { state, commands: [{ type: "emitEffect", effect: "impactBurst" }] };
        }
        return enterPhase({ ...state, thrustTicksRemaining: 0 }, "landed", [
          { type: "setVelocity", velocity: { x: 0, y: 0 }, angularVelocity: 0 },
          { type: "emitEffect", effect: "thrustTrail", mode: "stop" },
          { type: "emitEffect", effect: "landingDust" },
          { type: "scheduleTimer", key: "cooldown", seconds: config.cooldownSeconds },
        ]);
      }

      default:
        return { state, commands: [] };
    }
  },
};
