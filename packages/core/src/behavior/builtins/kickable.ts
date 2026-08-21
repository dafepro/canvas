import { clamp, dot, normalize, sub } from "../../math/vec2.js";
import type { BehaviorContext, BehaviorResult, ItemBehavior } from "../behavior.js";
import type { BehaviorEvent } from "../events.js";

/**
 * Spec 5.4. A sensor-based kick. The avatar glides through the item while the
 * item still moves. The cooldown stops one overlap applying an impulse on every
 * physics tick.
 */
export interface KickableConfig {
  sensorId: string;
  kickStrength: number;
  minImpulse: number;
  maxImpulse: number;
  cooldownSeconds: number;
}

export const defaultKickableConfig: KickableConfig = {
  sensorId: "kick",
  kickStrength: 1.4,
  minImpulse: 0,
  maxImpulse: 30,
  cooldownSeconds: 0.25,
};

export interface KickableState {
  /** Tick each avatar may next kick this item on. Sorted for stable snapshots. */
  cooldownUntil: [entityId: string, tick: number][];
  kickCount: number;
}

const readCooldown = (state: KickableState, id: string): number =>
  state.cooldownUntil.find(([key]) => key === id)?.[1] ?? 0;

const writeCooldown = (
  state: KickableState,
  id: string,
  tick: number,
): KickableState["cooldownUntil"] =>
  [...state.cooldownUntil.filter(([key]) => key !== id), [id, tick] as [string, number]].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );

export const KickableBehavior: ItemBehavior<KickableConfig, KickableState> = {
  behaviorType: "kickable",
  stateVersion: 1,
  subscribes: ["contact.enter", "contact.stay", "room.wake"],

  initialState: () => ({ cooldownUntil: [], kickCount: 0 }),

  normalizeForSleep: (_config, state) => ({ cooldownUntil: [], kickCount: state.kickCount }),

  onEvent(
    ctx: BehaviorContext,
    config: KickableConfig,
    state: Readonly<KickableState>,
    event: BehaviorEvent,
  ): BehaviorResult<KickableState> {
    if (event.type === "room.wake") {
      return { state: { cooldownUntil: [], kickCount: state.kickCount }, commands: [] };
    }
    if (event.type !== "contact.enter" && event.type !== "contact.stay") {
      return { state, commands: [] };
    }
    if (event.selfColliderId !== config.sensorId) return { state, commands: [] };
    if (event.other.kind !== "avatar") return { state, commands: [] };
    if (ctx.tick < readCooldown(state, event.other.entityId)) {
      return { state, commands: [] };
    }

    const selfTransform = ctx.transform();
    const otherTransform = ctx.transform(event.other.entityId);
    if (!selfTransform || !otherTransform) return { state, commands: [] };

    // Contact normal points from the avatar toward the item centre.
    const contactNormal = normalize(sub(selfTransform, otherTransform));
    const avatarVelocity = ctx.velocity(event.other.entityId) ?? { x: 0, y: 0 };
    const itemVelocity = ctx.velocity() ?? { x: 0, y: 0 };
    const closingSpeed = Math.max(
      0,
      dot(sub(avatarVelocity, itemVelocity), contactNormal),
    );
    const magnitude = clamp(
      config.kickStrength * closingSpeed,
      config.minImpulse,
      config.maxImpulse,
    );
    if (magnitude <= 0) return { state, commands: [] };

    return {
      state: {
        cooldownUntil: writeCooldown(
          state as KickableState,
          event.other.entityId,
          ctx.tick + ctx.ticksFor(config.cooldownSeconds),
        ),
        kickCount: state.kickCount + 1,
      },
      commands: [
        {
          type: "applyImpulse",
          impulse: { x: contactNormal.x * magnitude, y: contactNormal.y * magnitude },
        },
        {
          type: "emitEffect",
          effect: "kickPuff",
          params: { magnitude: Number(magnitude.toFixed(3)) },
        },
      ],
    };
  },
};
