import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
} from "@canvas-physics/core";

export type OrbTheme = "mint" | "coral" | "violet";

export interface ReactiveOrbConfig {
  theme: OrbTheme;
}

export interface ReactiveOrbState {
  appliedTheme?: OrbTheme;
  activations: number;
}

export const defaultReactiveOrbConfig: ReactiveOrbConfig = { theme: "mint" };

export const ReactiveOrbBehavior: ItemBehavior<ReactiveOrbConfig, ReactiveOrbState> = {
  behaviorType: "reactiveOrb",
  stateVersion: 1,
  subscribes: ["tick", "room.wake", "contact.enter"],
  initialState: () => ({ activations: 0 }),
  onEvent(
    _ctx: BehaviorContext,
    config: ReactiveOrbConfig,
    state: Readonly<ReactiveOrbState>,
    event: BehaviorEvent,
  ): BehaviorResult<ReactiveOrbState> {
    if (event.type === "tick" || event.type === "room.wake") {
      if (state.appliedTheme === config.theme) {
        return { state: state as ReactiveOrbState, commands: [] };
      }
      return {
        state: { ...state, appliedTheme: config.theme },
        commands: [
          { type: "setSpriteVariant", variant: config.theme, persistent: true },
        ],
      };
    }

    if (
      event.type !== "contact.enter" ||
      event.selfColliderId !== "touch" ||
      event.other.kind !== "avatar"
    ) {
      return { state: state as ReactiveOrbState, commands: [] };
    }

    return {
      state: { ...state, activations: state.activations + 1 },
      commands: [
        { type: "startAnimation", animation: "pulse", loop: false },
        { type: "emitEffect", effect: "portalFlash" },
      ],
    };
  },
};
