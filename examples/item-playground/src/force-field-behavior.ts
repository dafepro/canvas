import type {
  BehaviorContext,
  BehaviorEvent,
  BehaviorResult,
  ItemBehavior,
  Vec2,
} from "@canvas-physics/core";

export interface ForceFieldConfig {
  sensorId: string;
  mode: "directional" | "radial";
  /** Acceleration for directional fields; inverse-square strength for radial fields. */
  strength: number;
  direction: Vec2;
  softening: number;
  maxAcceleration: number;
}

export interface ForceFieldState {
  entries: number;
}

export const antigravityFieldConfig: ForceFieldConfig = {
  sensorId: "field",
  mode: "directional",
  strength: 18,
  direction: { x: 0, y: -1 },
  softening: 1,
  maxAcceleration: 18,
};

export const blackHoleFieldConfig: ForceFieldConfig = {
  sensorId: "field",
  mode: "radial",
  strength: 450,
  direction: { x: 0, y: 0 },
  softening: 1.5,
  maxAcceleration: 70,
};

const fieldAcceleration = (
  ctx: BehaviorContext,
  config: ForceFieldConfig,
  targetId: string,
): Vec2 | undefined => {
  if (config.mode === "directional") {
    const length = Math.hypot(config.direction.x, config.direction.y);
    if (length < 0.0001) return undefined;
    const magnitude = Math.min(config.strength, config.maxAcceleration);
    const rotation = ctx.transform()?.rotation ?? 0;
    const localX = config.direction.x / length;
    const localY = config.direction.y / length;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: (localX * cos - localY * sin) * magnitude,
      y: (localX * sin + localY * cos) * magnitude,
    };
  }

  const centre = ctx.transform();
  const target = ctx.transform(targetId);
  if (!centre || !target) return undefined;
  const dx = centre.x - target.x;
  const dy = centre.y - target.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.0001) return undefined;
  const magnitude = Math.min(
    config.maxAcceleration,
    config.strength / (distance * distance + config.softening * config.softening),
  );
  return { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude };
};

/** A sensor-only item behavior that bends dynamic item trajectories. */
export const ForceFieldBehavior: ItemBehavior<ForceFieldConfig, ForceFieldState> = {
  behaviorType: "playground.forceField",
  stateVersion: 1,
  subscribes: ["contact.enter", "contact.stay"],
  initialState: () => ({ entries: 0 }),
  onEvent(
    ctx: BehaviorContext,
    config: ForceFieldConfig,
    state: Readonly<ForceFieldState>,
    event: BehaviorEvent,
  ): BehaviorResult<ForceFieldState> {
    if (
      (event.type !== "contact.enter" && event.type !== "contact.stay") ||
      event.selfColliderId !== config.sensorId ||
      event.other.kind !== "item"
    ) {
      return { state: state as ForceFieldState, commands: [] };
    }
    const acceleration = fieldAcceleration(ctx, config, event.other.entityId);
    if (!acceleration) return { state: state as ForceFieldState, commands: [] };

    return {
      state: event.type === "contact.enter" ? { entries: state.entries + 1 } : state,
      commands: [
        { type: "applyForce", target: event.other.entityId, force: acceleration },
        ...(event.type === "contact.enter"
          ? [{
              type: "emitEffect" as const,
              target: event.other.entityId,
              effect: config.mode === "radial" ? "portalFlash" : "spaceSparkle",
            }]
          : []),
      ],
    };
  },
};
