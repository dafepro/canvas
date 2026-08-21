import type { BehaviorContext, BehaviorResult, ItemBehavior } from "../behavior.js";
import type { BehaviorEvent } from "../events.js";

/**
 * Spec 17.4. A portal is a sensor plus a teleport command, not a special case
 * inside the physics engine.
 */
export interface PortalConfig {
  sensorId: string;
  target: { x: number; y: number };
  /** Rotation added to the body on transit, in radians. */
  rotationDelta: number;
  velocityScale: number;
  cooldownSeconds: number;
  /** Entity kinds the portal accepts. */
  accepts: ("avatar" | "item")[];
}

export const defaultPortalConfig: PortalConfig = {
  sensorId: "portal",
  target: { x: 0, y: 0 },
  rotationDelta: 0,
  velocityScale: 1,
  cooldownSeconds: 1,
  accepts: ["avatar", "item"],
};

export interface PortalState {
  transitCount: number;
  cooldownUntilTick: number;
}

export const PortalBehavior: ItemBehavior<PortalConfig, PortalState> = {
  behaviorType: "portal",
  stateVersion: 1,
  subscribes: ["contact.enter", "room.wake"],

  initialState: () => ({ transitCount: 0, cooldownUntilTick: 0 }),

  normalizeForSleep: (_config, state) => ({
    transitCount: state.transitCount,
    cooldownUntilTick: 0,
  }),

  onEvent(
    ctx: BehaviorContext,
    config: PortalConfig,
    state: Readonly<PortalState>,
    event: BehaviorEvent,
  ): BehaviorResult<PortalState> {
    if (event.type === "room.wake") {
      return { state: { ...state, cooldownUntilTick: 0 }, commands: [] };
    }
    if (event.type !== "contact.enter") return { state, commands: [] };
    if (event.selfColliderId !== config.sensorId) return { state, commands: [] };
    if (ctx.tick < state.cooldownUntilTick) return { state, commands: [] };
    const kind = event.other.kind;
    if (kind !== "avatar" && kind !== "item") return { state, commands: [] };
    if (!config.accepts.includes(kind)) return { state, commands: [] };

    const transform = ctx.transform(event.other.entityId);
    const velocity = ctx.velocity(event.other.entityId) ?? { x: 0, y: 0 };
    if (!transform) return { state, commands: [] };

    return {
      state: {
        transitCount: state.transitCount + 1,
        cooldownUntilTick: ctx.tick + ctx.ticksFor(config.cooldownSeconds),
      },
      commands: [
        {
          type: "teleport",
          target: event.other.entityId,
          position: config.target,
          rotation: transform.rotation + config.rotationDelta,
          velocity: {
            x: velocity.x * config.velocityScale,
            y: velocity.y * config.velocityScale,
          },
        },
        { type: "emitEffect", effect: "portalFlash" },
      ],
    };
  },
};
