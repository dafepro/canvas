import type { CanvasDefinition } from "../model/canvas-definition.js";
import type { ItemDefinition, TuningCondition, TuningRule } from "../model/item-definition.js";

export interface TuningTarget {
  width: number;
  height: number;
  orientation: "topDown" | "side";
  tags?: string[];
}

export const canvasTuningTarget = (canvas: CanvasDefinition): TuningTarget => ({
  width: canvas.size.width,
  height: canvas.size.height,
  orientation: canvas.orientation,
});

export const conditionMatches = (
  condition: TuningCondition,
  target: TuningTarget,
): boolean => {
  if (condition.minCanvasWidth !== undefined && target.width < condition.minCanvasWidth) {
    return false;
  }
  if (condition.maxCanvasWidth !== undefined && target.width > condition.maxCanvasWidth) {
    return false;
  }
  if (condition.minCanvasHeight !== undefined && target.height < condition.minCanvasHeight) {
    return false;
  }
  if (condition.maxCanvasHeight !== undefined && target.height > condition.maxCanvasHeight) {
    return false;
  }
  if (condition.orientation !== undefined && target.orientation !== condition.orientation) {
    return false;
  }
  if (condition.canvasTag !== undefined && !(target.tags ?? []).includes(condition.canvasTag)) {
    return false;
  }
  return true;
};

/**
 * Spec 7.3. Resolves item configuration from the default config plus the
 * matching tuning rules, then the spawn-time overrides. Rules apply in
 * declaration order, so a later rule wins. The result is stored on the instance
 * so every client receives the same values.
 */
export const resolveItemConfig = <Config extends Record<string, unknown>>(
  definition: ItemDefinition<Config>,
  target: TuningTarget,
  overrides: Partial<Config> = {},
): Config => {
  const resolved: Record<string, unknown> = { ...(definition.defaultConfig ?? {}) };
  for (const rule of definition.tuningRules ?? []) {
    if (conditionMatches(rule.when, target)) {
      Object.assign(resolved, rule.overrides);
    }
  }
  Object.assign(resolved, overrides);
  return resolved as Config;
};

/** Reports the rules that matched, for the debug overlay and tests. */
export const explainTuning = (
  rules: TuningRule[] | undefined,
  target: TuningTarget,
): { index: number; rule: TuningRule }[] =>
  (rules ?? [])
    .map((rule, index) => ({ index, rule }))
    .filter(({ rule }) => conditionMatches(rule.when, target));
