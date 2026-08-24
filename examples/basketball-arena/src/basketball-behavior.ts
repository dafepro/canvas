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

export type BasketballTeam = "teal" | "coral";

export interface BasketballConfig {
  sensorId: string;
  kickStrength: number;
  pinchStrength: number;
  minimumKickImpulse: number;
  maxImpulse: number;
  spinTransfer: number;
  maxAngularSpeed: number;
  cooldownSeconds: number;
  basketResetSeconds: number;
  gameResetSeconds: number;
  pointsPerBasket: number;
  winningScore: number;
  centre: Vec2;
  tealScoreTag: string;
  coralScoreTag: string;
}

export interface BasketballState {
  phase: "playing" | "basket" | "gameOver";
  tealScore: number;
  coralScore: number;
  lastScoringTeam?: BasketballTeam;
  winner?: BasketballTeam;
  kickCount: number;
  cooldownUntil: [entityId: string, tick: number][];
}

export const defaultBasketballConfig: BasketballConfig = {
  sensorId: "kick",
  kickStrength: 2.15,
  pinchStrength: 1.2,
  minimumKickImpulse: 5,
  maxImpulse: 28,
  spinTransfer: 0.65,
  maxAngularSpeed: 14,
  cooldownSeconds: 0.18,
  basketResetSeconds: 1.25,
  gameResetSeconds: 3,
  pointsPerBasket: 2,
  winningScore: 6,
  centre: { x: 35, y: 21 },
  tealScoreTag: "tealScores",
  coralScoreTag: "coralScores",
};

const POSSESSION_RESET_TIMER = "basketball-possession-reset";
const GAME_RESET_TIMER = "basketball-game-reset";

const cooldownFor = (state: Readonly<BasketballState>, entityId: string): number =>
  state.cooldownUntil.find(([id]) => id === entityId)?.[1] ?? 0;

const withCooldown = (
  state: Readonly<BasketballState>,
  entityId: string,
  tick: number,
): BasketballState["cooldownUntil"] => [
  ...state.cooldownUntil.filter(([id]) => id !== entityId),
  [entityId, tick],
].sort((a, b) => a[0].localeCompare(b[0])) as BasketballState["cooldownUntil"];

const resetCommands = (centre: Vec2): BehaviorResult<BasketballState>["commands"] => [
  { type: "teleport", position: centre, velocity: { x: 0, y: 0 }, rotation: 0 },
  { type: "setVelocity", angularVelocity: 0 },
  { type: "setBodyMode", mode: "dynamic" },
];

const resetPossession = (
  state: Readonly<BasketballState>,
  centre: Vec2,
): BehaviorResult<BasketballState> => ({
  state: {
    ...state,
    phase: "playing",
    lastScoringTeam: undefined,
    cooldownUntil: [],
  },
  commands: resetCommands(centre),
});

const resetGame = (
  state: Readonly<BasketballState>,
  centre: Vec2,
): BehaviorResult<BasketballState> => ({
  state: {
    ...state,
    phase: "playing",
    tealScore: 0,
    coralScore: 0,
    lastScoringTeam: undefined,
    winner: undefined,
    cooldownUntil: [],
  },
  commands: [
    ...resetCommands(centre),
    { type: "emitEffect", effect: "gameReset", params: {} },
  ],
});

const scoringTeam = (
  event: Extract<BehaviorEvent, { type: "region.enter" }>,
  config: Readonly<BasketballConfig>,
): BasketballTeam | undefined =>
  event.tags.includes(config.tealScoreTag)
    ? "teal"
    : event.tags.includes(config.coralScoreTag)
      ? "coral"
      : undefined;

export const BasketballBehavior: ItemBehavior<BasketballConfig, BasketballState> = {
  behaviorType: "basketballGameBall",
  stateVersion: 1,
  subscribes: ["contact.enter", "contact.stay", "region.enter", "timer", "room.wake"],

  initialState: () => ({
    phase: "playing",
    tealScore: 0,
    coralScore: 0,
    kickCount: 0,
    cooldownUntil: [],
  }),

  onEvent(
    ctx: BehaviorContext,
    config: BasketballConfig,
    state: Readonly<BasketballState>,
    event: BehaviorEvent,
  ): BehaviorResult<BasketballState> {
    if (event.type === "room.wake") {
      if (state.phase === "gameOver") return resetGame(state, config.centre);
      if (state.phase === "basket") return resetPossession(state, config.centre);
      return { state: { ...state, cooldownUntil: [] }, commands: [] };
    }

    if (event.type === "timer" && event.key === POSSESSION_RESET_TIMER) {
      return resetPossession(state, config.centre);
    }

    if (event.type === "timer" && event.key === GAME_RESET_TIMER) {
      return resetGame(state, config.centre);
    }

    if (event.type === "region.enter" && state.phase === "playing") {
      const team = scoringTeam(event, config);
      if (!team) return { state: state as BasketballState, commands: [] };

      const tealScore = state.tealScore + (team === "teal" ? config.pointsPerBasket : 0);
      const coralScore = state.coralScore + (team === "coral" ? config.pointsPerBasket : 0);
      const won = (team === "teal" ? tealScore : coralScore) >= config.winningScore;

      return {
        state: {
          ...state,
          phase: won ? "gameOver" : "basket",
          tealScore,
          coralScore,
          lastScoringTeam: team,
          winner: won ? team : undefined,
          cooldownUntil: [],
        },
        commands: [
          {
            type: "emitEffect",
            effect: "basketScored",
            params: {
              team,
              points: config.pointsPerBasket,
              total: team === "teal" ? tealScore : coralScore,
              gameOver: won,
            },
          },
          {
            type: "scheduleTimer",
            key: won ? GAME_RESET_TIMER : POSSESSION_RESET_TIMER,
            seconds: won ? config.gameResetSeconds : config.basketResetSeconds,
          },
        ],
      };
    }

    if (
      state.phase !== "playing" ||
      (event.type !== "contact.enter" && event.type !== "contact.stay") ||
      event.selfColliderId !== config.sensorId ||
      event.other.kind !== "avatar" ||
      ctx.tick < cooldownFor(state, event.other.entityId)
    ) {
      return { state: state as BasketballState, commands: [] };
    }

    const ball = ctx.transform();
    const avatar = ctx.transform(event.other.entityId);
    if (!ball || !avatar) return { state: state as BasketballState, commands: [] };

    const normal = normalize(sub(ball, avatar));
    const avatarVelocity = ctx.velocity(event.other.entityId) ?? { x: 0, y: 0 };
    const ballVelocity = ctx.velocity() ?? { x: 0, y: 0 };
    const closingSpeed = Math.max(0, dot(avatarVelocity, normal));
    const incomingSpeed = Math.max(0, -dot(ballVelocity, normal));
    if (closingSpeed < 0.15 && incomingSpeed < 0.5) {
      return { state: state as BasketballState, commands: [] };
    }

    const magnitude = clamp(
      Math.max(
        config.minimumKickImpulse,
        config.kickStrength * closingSpeed + config.pinchStrength * incomingSpeed,
      ),
      0,
      config.maxImpulse,
    );
    const tangent = { x: -normal.y, y: normal.x };
    const tangentialSpeed = dot(sub(avatarVelocity, ballVelocity), tangent);
    const angularVelocity = clamp(
      (ctx.angularVelocity() ?? 0) - tangentialSpeed * config.spinTransfer,
      -config.maxAngularSpeed,
      config.maxAngularSpeed,
    );

    return {
      state: {
        ...state,
        kickCount: state.kickCount + 1,
        cooldownUntil: withCooldown(
          state,
          event.other.entityId,
          ctx.tick + ctx.ticksFor(config.cooldownSeconds),
        ),
      },
      commands: [
        { type: "applyImpulse", impulse: { x: normal.x * magnitude, y: normal.y * magnitude } },
        { type: "setVelocity", angularVelocity },
        { type: "emitEffect", effect: "ballHit", params: { magnitude } },
      ],
    };
  },
};
