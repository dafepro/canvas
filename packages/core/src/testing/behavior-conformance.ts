import type { ItemBehavior } from "../behavior/behavior.js";
import { eventOrder } from "../behavior/events.js";
import { BehaviorTestHarness, type HarnessOptions } from "./harness.js";

export type BehaviorConformanceIssueCode =
  | "invalid_behavior_type"
  | "invalid_state_version"
  | "duplicate_subscription"
  | "unknown_subscription"
  | "config_not_serializable"
  | "initial_state_failed"
  | "initial_state_not_serializable"
  | "initial_state_not_deterministic"
  | "missing_migrations"
  | "migration_version_mismatch"
  | "migration_case_required"
  | "migration_failed"
  | "migration_not_serializable"
  | "migration_not_deterministic"
  | "normalization_failed"
  | "normalization_not_serializable"
  | "normalization_not_deterministic"
  | "scenario_required"
  | "scenario_failed"
  | "scenario_not_deterministic";

export interface BehaviorConformanceIssue {
  readonly code: BehaviorConformanceIssueCode;
  readonly message: string;
  readonly scenario?: string;
}

export interface BehaviorConformanceReport {
  readonly ok: boolean;
  readonly behaviorType: string;
  readonly stateVersion: number;
  readonly scenariosRun: number;
  readonly issues: readonly Readonly<BehaviorConformanceIssue>[];
}

export interface BehaviorConformanceScenario<Config, State> {
  readonly name: string;
  /** Feed a representative deterministic event sequence through the public harness. */
  exercise(harness: BehaviorTestHarness<Config, State>): void;
}

export interface BehaviorConformanceOptions<Config, State> {
  readonly scenarios: readonly BehaviorConformanceScenario<Config, State>[];
  readonly harness?: HarnessOptions;
  /** Defaults to true. Durable state above version 1 requires complete cases. */
  readonly persistent?: boolean;
  readonly migrationCases?: readonly {
    readonly fromVersion: number;
    readonly state: unknown;
  }[];
}

/**
 * Runs framework-neutral checks suitable for an external behavior package.
 * The returned report is immutable and can be asserted by Vitest, Jest, or any
 * other consumer test runner.
 */
export const runBehaviorConformance = <Config, State>(
  behavior: ItemBehavior<Config, State>,
  config: Config,
  options: BehaviorConformanceOptions<Config, State>,
): Readonly<BehaviorConformanceReport> => {
  const issues: BehaviorConformanceIssue[] = [];
  const add = (
    code: BehaviorConformanceIssueCode,
    message: string,
    scenario?: string,
  ): void => { issues.push(Object.freeze({ code, message, scenario })); };

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(behavior.behaviorType)) {
    add("invalid_behavior_type", "behaviorType must be a non-empty portable identifier");
  }
  if (!Number.isInteger(behavior.stateVersion) || behavior.stateVersion < 1) {
    add("invalid_state_version", "stateVersion must be a positive integer");
  }

  const seenSubscriptions = new Set<string>();
  for (const subscription of behavior.subscribes ?? []) {
    if (seenSubscriptions.has(subscription)) {
      add("duplicate_subscription", `subscription '${subscription}' is duplicated`);
    }
    seenSubscriptions.add(subscription);
    if (!(subscription in eventOrder)) {
      add("unknown_subscription", `subscription '${subscription}' is not a behavior event`);
    }
  }

  if (!isJsonSerializable(config)) {
    add("config_not_serializable", "behavior config must be JSON-serializable data");
  }

  let initialA: State | undefined;
  let initialB: State | undefined;
  try {
    initialA = behavior.initialState(cloneForRun(config));
    initialB = behavior.initialState(cloneForRun(config));
    if (!isJsonSerializable(initialA) || !isJsonSerializable(initialB)) {
      add("initial_state_not_serializable", "initialState must return JSON-serializable data");
    }
    if (comparisonValue(initialA) !== comparisonValue(initialB)) {
      add("initial_state_not_deterministic", "initialState returned different values for equal config");
    }
  } catch (cause) {
    add(
      "initial_state_failed",
      `initialState failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (initialA !== undefined && behavior.normalizeForSleep) {
    try {
      const normalizedA = behavior.normalizeForSleep(
        cloneForRun(config),
        cloneForRun(initialA),
      );
      const normalizedB = behavior.normalizeForSleep(
        cloneForRun(config),
        cloneForRun(initialA),
      );
      if (!isJsonSerializable(normalizedA) || !isJsonSerializable(normalizedB)) {
        add(
          "normalization_not_serializable",
          "normalizeForSleep must return JSON-serializable data",
        );
      }
      if (comparisonValue(normalizedA) !== comparisonValue(normalizedB)) {
        add(
          "normalization_not_deterministic",
          "normalizeForSleep returned different values for equal inputs",
        );
      }
    } catch (cause) {
      add(
        "normalization_failed",
        `normalizeForSleep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  if ((options.persistent ?? true) && behavior.stateVersion > 1) {
    if (!behavior.migrations) {
      add("missing_migrations", "durable state above version 1 requires a migration chain");
    } else {
      if (behavior.migrations.currentVersion !== behavior.stateVersion) {
        add(
          "migration_version_mismatch",
          "migration currentVersion must equal behavior stateVersion",
        );
      }
      const cases = new Map(
        (options.migrationCases ?? []).map((entry) => [entry.fromVersion, entry.state]),
      );
      for (let fromVersion = 1; fromVersion < behavior.stateVersion; fromVersion++) {
        if (!cases.has(fromVersion)) {
          add(
            "migration_case_required",
            `a migration case from state version ${fromVersion} is required`,
          );
          continue;
        }
        try {
          const input = cases.get(fromVersion);
          const migratedA = behavior.migrations.migrate(
            cloneForRun(input) as State,
            fromVersion,
          );
          const migratedB = behavior.migrations.migrate(
            cloneForRun(input) as State,
            fromVersion,
          );
          if (!isJsonSerializable(migratedA) || !isJsonSerializable(migratedB)) {
            add(
              "migration_not_serializable",
              `migration from state version ${fromVersion} must return JSON data`,
            );
          }
          if (comparisonValue(migratedA) !== comparisonValue(migratedB)) {
            add(
              "migration_not_deterministic",
              `migration from state version ${fromVersion} is not deterministic`,
            );
          }
        } catch (cause) {
          add(
            "migration_failed",
            `migration from state version ${fromVersion} failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    }
  }

  if (options.scenarios.length === 0) {
    add("scenario_required", "at least one representative behavior scenario is required");
  }

  let scenariosRun = 0;
  for (const scenario of options.scenarios) {
    let first: string;
    let second: string;
    try {
      first = runScenario(behavior, config, scenario, options.harness);
      second = runScenario(behavior, config, scenario, options.harness);
      scenariosRun++;
    } catch (cause) {
      add(
        "scenario_failed",
        `scenario failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        scenario.name,
      );
      continue;
    }
    if (first !== second) {
      add(
        "scenario_not_deterministic",
        "replaying the same scenario produced different state, commands, effects, or bodies",
        scenario.name,
      );
    }
  }

  const frozenIssues = Object.freeze(issues);
  return Object.freeze({
    ok: issues.length === 0,
    behaviorType: behavior.behaviorType,
    stateVersion: behavior.stateVersion,
    scenariosRun,
    issues: frozenIssues,
  });
};

const runScenario = <Config, State>(
  behavior: ItemBehavior<Config, State>,
  config: Config,
  scenario: BehaviorConformanceScenario<Config, State>,
  options?: HarnessOptions,
): string => {
  const harness = new BehaviorTestHarness(behavior, cloneForRun(config), options);
  scenario.exercise(harness);
  const bodies = [...harness.host.bodies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, body]) => ({
      entityId,
      transform: body.transform,
      velocity: body.velocity,
      angularVelocity: body.angularVelocity,
      mode: body.mode,
      elevation: body.elevation,
      tags: body.tags,
      variant: body.variant,
      animation: body.animation,
      disabledColliders: [...body.disabledColliders].sort(),
      forces: body.forces,
      impulses: body.impulses,
      torques: body.torques,
    }));
  return comparisonValue({
    tick: harness.tick,
    state: harness.state,
    commands: harness.commandLog,
    effects: harness.effects(),
    bodies,
  });
};

const cloneForRun = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const isJsonSerializable = (value: unknown): boolean => {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
};

const comparisonValue = (value: unknown): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item && typeof item === "object") {
      if (seen.has(item)) return { $cycle: true };
      seen.add(item);
      if (!Array.isArray(item) && !(item instanceof Set) && !(item instanceof Map)) {
        return Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right)),
        );
      }
    }
    if (item instanceof Set) return [...item].sort();
    if (item instanceof Map) return [...item.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)));
    return item;
  })!;
};
