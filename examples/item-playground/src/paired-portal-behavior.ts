import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
} from "@canvas-physics/core";

export interface PairedPortalConfig {
  endpointOffset: number;
  exitClearance: number;
  velocityScale: number;
  cooldownSeconds: number;
  accepts: ("avatar" | "item")[];
}

export interface PairedPortalState {
  transitCount: number;
  cooldownUntilTick: number;
}

export const defaultPairedPortalConfig: PairedPortalConfig = {
  endpointOffset: 4.3,
  exitClearance: 3.7,
  velocityScale: 1,
  cooldownSeconds: 0.45,
  accepts: ["avatar", "item"],
};

const endpointDirection = (colliderId: string | undefined): -1 | 1 | undefined => {
  if (colliderId === "left-portal") return 1;
  if (colliderId === "right-portal") return -1;
  return undefined;
};

/**
 * A consumer-authored composite item: both portal sensors belong to one item,
 * so moving, rotating, or scaling the item can never break the pairing.
 */
export const PairedPortalBehavior: ItemBehavior<PairedPortalConfig, PairedPortalState> = {
  behaviorType: "playground.pairedPortal",
  stateVersion: 1,
  subscribes: ["contact.enter", "room.wake"],
  initialState: () => ({ transitCount: 0, cooldownUntilTick: 0 }),
  normalizeForSleep: (_config, state) => ({
    transitCount: state.transitCount,
    cooldownUntilTick: 0,
  }),
  onEvent(
    ctx: BehaviorContext,
    config: PairedPortalConfig,
    state: Readonly<PairedPortalState>,
    event: BehaviorEvent,
  ): BehaviorResult<PairedPortalState> {
    if (event.type === "room.wake") {
      return { state: { ...state, cooldownUntilTick: 0 }, commands: [] };
    }
    if (event.type !== "contact.enter" || ctx.tick < state.cooldownUntilTick) {
      return { state: state as PairedPortalState, commands: [] };
    }
    const exitDirection = endpointDirection(event.selfColliderId);
    if (
      exitDirection === undefined ||
      (event.other.kind !== "avatar" && event.other.kind !== "item") ||
      !config.accepts.includes(event.other.kind)
    ) {
      return { state: state as PairedPortalState, commands: [] };
    }

    const portal = ctx.transform(event.self);
    const traveler = ctx.transform(event.other.entityId);
    if (!portal || !traveler) {
      return { state: state as PairedPortalState, commands: [] };
    }
    const scale = portal.scale ?? 1;
    const localExit =
      exitDirection * (config.endpointOffset + config.exitClearance) * scale;
    const cos = Math.cos(portal.rotation);
    const sin = Math.sin(portal.rotation);
    const velocity = ctx.velocity(event.other.entityId) ?? { x: 0, y: 0 };

    return {
      state: {
        transitCount: state.transitCount + 1,
        cooldownUntilTick: ctx.tick + ctx.ticksFor(config.cooldownSeconds),
      },
      commands: [
        {
          type: "teleport",
          target: event.other.entityId,
          position: {
            x: portal.x + localExit * cos,
            y: portal.y + localExit * sin,
          },
          rotation: traveler.rotation,
          velocity: {
            x: velocity.x * config.velocityScale,
            y: velocity.y * config.velocityScale,
          },
        },
        { type: "startAnimation", animation: "surge", loop: false },
        {
          type: "emitEffect",
          target: event.other.entityId,
          effect: "portalFlash",
        },
      ],
    };
  },
};
