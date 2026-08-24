import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
} from "@canvas-physics/core";

export type OrbTheme = "mint" | "coral" | "violet" | "custom";

export interface ReactiveOrbConfig {
  theme: OrbTheme;
  customColor: string;
}

export interface ReactiveOrbState {
  appliedTheme?: OrbTheme;
  appliedTint?: number;
  activations: number;
}

export const defaultReactiveOrbConfig: ReactiveOrbConfig = {
  theme: "mint",
  customColor: "#4f7cff",
};

export const colorStringToTint = (color: string): number => {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "4f7cff";
  return Number.parseInt(normalized, 16);
};

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
      const tint = config.theme === "custom" ? colorStringToTint(config.customColor) : undefined;
      if (state.appliedTheme === config.theme && state.appliedTint === tint) {
        return { state: state as ReactiveOrbState, commands: [] };
      }
      return {
        state: { ...state, appliedTheme: config.theme, appliedTint: tint },
        commands: [
          { type: "setSpriteVariant", variant: config.theme, persistent: true },
          { type: "setSpriteTint", tint, persistent: true },
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
