import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
} from "@canvas-physics/core";

export type GraffitiStyle = "bubble" | "wild" | "marker" | "neon";
export type GraffitiSize = "small" | "medium" | "large" | "huge";

export interface GraffitiConfig {
  text: string;
  style: GraffitiStyle;
  size: GraffitiSize;
  color: string;
  accentColor: string;
}

export interface GraffitiRenderState extends GraffitiConfig {
  fontSize: number;
}

export interface GraffitiState {
  render: GraffitiRenderState;
}

export const defaultGraffitiConfig: GraffitiConfig = {
  text: "MAKE\nSOMETHING",
  style: "bubble",
  size: "large",
  color: "#ffe45c",
  accentColor: "#713bdb",
};

const sizes: Record<GraffitiSize, number> = {
  small: 0.72,
  medium: 1,
  large: 1.35,
  huge: 1.75,
};

const safeColor = (value: string, fallback: string): string =>
  /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;

export const graffitiRenderState = (config: GraffitiConfig): GraffitiRenderState => ({
  text: config.text.replaceAll("\r\n", "\n").slice(0, 120),
  style: (["bubble", "wild", "marker", "neon"] as const).includes(config.style)
    ? config.style
    : "bubble",
  size: (["small", "medium", "large", "huge"] as const).includes(config.size)
    ? config.size
    : "medium",
  color: safeColor(config.color, "#ffe45c"),
  accentColor: safeColor(config.accentColor, "#713bdb"),
  fontSize: sizes[config.size] ?? sizes.medium,
});

export const GraffitiBehavior: ItemBehavior<GraffitiConfig, GraffitiState> = {
  behaviorType: "playground.graffiti",
  stateVersion: 1,
  subscribes: ["tick", "room.wake"],
  initialState: (config) => ({ render: graffitiRenderState(config) }),
  onEvent(
    _ctx: BehaviorContext,
    config: GraffitiConfig,
    state: Readonly<GraffitiState>,
    _event: BehaviorEvent,
  ): BehaviorResult<GraffitiState> {
    const render = graffitiRenderState(config);
    if (JSON.stringify(render) === JSON.stringify(state.render)) {
      return { state: state as GraffitiState, commands: [] };
    }
    return { state: { render }, commands: [] };
  },
};
