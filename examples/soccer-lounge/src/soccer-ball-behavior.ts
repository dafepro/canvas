import {
  clamp,
  dot,
  normalize,
  sub,
  type BehaviorContext,
  type BehaviorEvent,
  type BehaviorResult,
  type ItemBehavior,
  type Vec2,
} from "@canvas-physics/core";

export interface SoccerBallConfig {
  sensorId: string;
  kickStrength: number;
  maxImpulse: number;
  cooldownSeconds: number;
  resetSeconds: number;
  centre: Vec2;
  homeGoalTag: string;
  awayGoalTag: string;
}

export interface SoccerBallState {
  phase: "playing" | "goal";
  homeScore: number;
  awayScore: number;
  lastScoringTeam?: "home" | "away";
  kickCount: number;
  cooldownUntil: [entityId: string, tick: number][];
}

export const defaultSoccerBallConfig: SoccerBallConfig = {
  sensorId: "kick",
  kickStrength: 1.7,
  maxImpulse: 24,
  cooldownSeconds: 0.2,
  resetSeconds: 1.5,
  centre: { x: 60, y: 36 },
  homeGoalTag: "rightGoal",
  awayGoalTag: "leftGoal",
};

const RESET_TIMER = "soccer-reset";

const readCooldown = (state: Readonly<SoccerBallState>, entityId: string): number =>
  state.cooldownUntil.find(([id]) => id === entityId)?.[1] ?? 0;

const writeCooldown = (
  state: Readonly<SoccerBallState>,
  entityId: string,
  tick: number,
): SoccerBallState["cooldownUntil"] =>
  [
    ...state.cooldownUntil.filter(([id]) => id !== entityId),
    [entityId, tick] as [string, number],
  ].sort((a, b) => a[0].localeCompare(b[0]));

const resetBall = (
  state: Readonly<SoccerBallState>,
  centre: Vec2,
): BehaviorResult<SoccerBallState> => ({
  state: { ...state, phase: "playing", cooldownUntil: [] },
  commands: [
    { type: "teleport", position: centre, velocity: { x: 0, y: 0 }, rotation: 0 },
    { type: "setBodyMode", mode: "dynamic" },
  ],
});

export const SoccerBallBehavior: ItemBehavior<SoccerBallConfig, SoccerBallState> = {
  behaviorType: "soccerBall",
  stateVersion: 1,
  subscribes: [
    "contact.enter",
    "contact.stay",
    "region.enter",
    "timer",
    "room.wake",
  ],

  initialState: () => ({
    phase: "playing",
    homeScore: 0,
    awayScore: 0,
    kickCount: 0,
    cooldownUntil: [],
  }),

  onEvent(
    ctx: BehaviorContext,
    config: SoccerBallConfig,
    state: Readonly<SoccerBallState>,
    event: BehaviorEvent,
  ): BehaviorResult<SoccerBallState> {
    if (event.type === "room.wake") {
      if (state.phase === "goal") return resetBall(state, config.centre);
      return { state: { ...state, cooldownUntil: [] }, commands: [] };
    }

    if (event.type === "timer" && event.key === RESET_TIMER) {
      return resetBall(state, config.centre);
    }

    if (event.type === "region.enter" && state.phase === "playing") {
      const scoringTeam = event.tags.includes(config.homeGoalTag)
        ? "home"
        : event.tags.includes(config.awayGoalTag)
          ? "away"
          : undefined;
      if (!scoringTeam) return { state: state as SoccerBallState, commands: [] };

      return {
        state: {
          ...state,
          phase: "goal",
          homeScore: state.homeScore + (scoringTeam === "home" ? 1 : 0),
          awayScore: state.awayScore + (scoringTeam === "away" ? 1 : 0),
          lastScoringTeam: scoringTeam,
          cooldownUntil: [],
        },
        commands: [
          {
            type: "emitEffect",
            effect: "goal",
            params: { team: scoringTeam },
          },
          { type: "scheduleTimer", key: RESET_TIMER, seconds: config.resetSeconds },
        ],
      };
    }

    if (
      state.phase !== "playing" ||
      (event.type !== "contact.enter" && event.type !== "contact.stay") ||
      event.selfColliderId !== config.sensorId ||
      event.other.kind !== "avatar" ||
      ctx.tick < readCooldown(state, event.other.entityId)
    ) {
      return { state: state as SoccerBallState, commands: [] };
    }

    const ball = ctx.transform();
    const avatar = ctx.transform(event.other.entityId);
    if (!ball || !avatar) return { state: state as SoccerBallState, commands: [] };

    const normal = normalize(sub(ball, avatar));
    const avatarVelocity = ctx.velocity(event.other.entityId) ?? { x: 0, y: 0 };
    const ballVelocity = ctx.velocity() ?? { x: 0, y: 0 };
    const closingSpeed = Math.max(0, dot(sub(avatarVelocity, ballVelocity), normal));
    const magnitude = clamp(config.kickStrength * closingSpeed, 0, config.maxImpulse);
    if (magnitude === 0) return { state: state as SoccerBallState, commands: [] };

    return {
      state: {
        ...state,
        kickCount: state.kickCount + 1,
        cooldownUntil: writeCooldown(
          state,
          event.other.entityId,
          ctx.tick + ctx.ticksFor(config.cooldownSeconds),
        ),
      },
      commands: [
        {
          type: "applyImpulse",
          impulse: { x: normal.x * magnitude, y: normal.y * magnitude },
        },
        { type: "startAnimation", animation: "hardKick", loop: false },
        { type: "emitEffect", effect: "kickPuff", params: { magnitude } },
      ],
    };
  },
};
