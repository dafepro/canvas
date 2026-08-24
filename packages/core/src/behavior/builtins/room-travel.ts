import type { BehaviorContext, BehaviorResult, ItemBehavior } from "../behavior.js";
import type { BehaviorEvent } from "../events.js";
import type { EffectEmission } from "../host.js";

export const ROOM_TRAVEL_EFFECT = "canvas.roomTravelRequested";

export interface RoomTravelConfig {
  sensorId: string;
  linkId: string;
  cooldownSeconds: number;
}

export const defaultRoomTravelConfig: RoomTravelConfig = {
  sensorId: "threshold",
  linkId: "",
  cooldownSeconds: 1,
};

export interface RoomTravelState {
  transitCount: number;
  /** Per-avatar suppression prevents one overlap from requesting repeatedly. */
  cooldownUntil: [avatarEntityId: string, tick: number][];
}

const cooldownFor = (state: Readonly<RoomTravelState>, entityId: string): number =>
  state.cooldownUntil.find(([id]) => id === entityId)?.[1] ?? 0;

const setCooldown = (
  state: Readonly<RoomTravelState>,
  entityId: string,
  tick: number,
): RoomTravelState["cooldownUntil"] =>
  [...state.cooldownUntil.filter(([id]) => id !== entityId), [entityId, tick] as [string, number]]
    .sort(([a], [b]) => a.localeCompare(b));

/** A sensor behavior that requests application-owned travel for avatars only. */
export const RoomTravelBehavior: ItemBehavior<RoomTravelConfig, RoomTravelState> = {
  behaviorType: "canvas.roomTravel",
  stateVersion: 1,
  subscribes: ["contact.enter", "room.wake"],
  initialState: () => ({ transitCount: 0, cooldownUntil: [] }),
  normalizeForSleep: (_config, state) => ({
    transitCount: state.transitCount,
    cooldownUntil: [],
  }),
  onEvent(
    ctx: BehaviorContext,
    config: RoomTravelConfig,
    state: Readonly<RoomTravelState>,
    event: BehaviorEvent,
  ): BehaviorResult<RoomTravelState> {
    if (event.type === "room.wake") {
      return { state: { ...state, cooldownUntil: [] }, commands: [] };
    }
    if (
      event.type !== "contact.enter" ||
      event.selfColliderId !== config.sensorId ||
      event.other.kind !== "avatar" ||
      !config.linkId ||
      ctx.tick < cooldownFor(state, event.other.entityId)
    ) {
      return { state: state as RoomTravelState, commands: [] };
    }

    return {
      state: {
        transitCount: state.transitCount + 1,
        cooldownUntil: setCooldown(
          state,
          event.other.entityId,
          ctx.tick + ctx.ticksFor(config.cooldownSeconds),
        ),
      },
      commands: [
        {
          type: "emitEffect",
          target: event.other.entityId,
          effect: ROOM_TRAVEL_EFFECT,
          params: { linkId: config.linkId, sourcePortalId: event.self },
        },
      ],
    };
  },
};

export interface RoomTravelRequest {
  travelerEntityId: string;
  linkId: string;
  sourcePortalId?: string;
}

/** Parses only well-formed travel effects, optionally for one local avatar. */
export const roomTravelRequestFromEffect = (
  effect: Readonly<EffectEmission>,
  localAvatarEntityId?: string,
): Readonly<RoomTravelRequest> | undefined => {
  if (
    effect.effect !== ROOM_TRAVEL_EFFECT ||
    (localAvatarEntityId !== undefined && effect.entityId !== localAvatarEntityId)
  ) return undefined;
  const linkId = effect.params?.linkId;
  const sourcePortalId = effect.params?.sourcePortalId;
  if (typeof linkId !== "string" || linkId.length === 0) return undefined;
  if (sourcePortalId !== undefined && typeof sourcePortalId !== "string") return undefined;
  return Object.freeze({
    travelerEntityId: effect.entityId,
    linkId,
    sourcePortalId,
  });
};
