import type { CanvasOrientation } from "../model/canvas-definition.js";
import type { EntityId } from "../registry/components.js";
import type { BehaviorContext } from "./behavior.js";
import type { BehaviorCommand } from "./commands.js";
import type { BehaviorEvent } from "./events.js";
import { sortEvents } from "./events.js";
import type { BehaviorHost } from "./host.js";
import { hashString, mulberry32 } from "./random.js";
import type { BehaviorRegistry } from "./registry.js";
import { TimerService } from "./timers.js";

export interface BehaviorSlot {
  entityId: EntityId;
  behaviorType: string;
  config: unknown;
  state: unknown;
  stateVersion: number;
  persistent: boolean;
  disabled?: boolean;
}

export interface CanvasContextInfo {
  id: string;
  width: number;
  height: number;
  orientation: CanvasOrientation;
}

export interface AppliedCommand {
  tick: number;
  entityId: EntityId;
  command: BehaviorCommand;
}

export interface StepReport {
  tick: number;
  eventsProcessed: number;
  commandsApplied: AppliedCommand[];
  errors: { entityId: EntityId; error: unknown }[];
}

/**
 * Turns normalized events into commands (spec 8.1). Events run in a stable order
 * inside a tick, and commands are applied after every handler has run, never
 * during handling (spec 8.4).
 */
export class BehaviorRuntime {
  private readonly slots = new Map<EntityId, BehaviorSlot>();
  private queue: BehaviorEvent[] = [];
  readonly timers: TimerService;

  constructor(
    private readonly registry: BehaviorRegistry,
    private readonly host: BehaviorHost,
    private readonly canvas: CanvasContextInfo,
    private readonly tickRate = 60,
  ) {
    this.timers = new TimerService(tickRate);
  }

  attach(
    slot: Omit<BehaviorSlot, "state" | "stateVersion"> & {
      state?: unknown;
      stateVersion?: number;
    },
  ): BehaviorSlot {
    const behavior = this.registry.require<any, any>(slot.behaviorType);
    let state = slot.state === undefined ? behavior.initialState(slot.config) : slot.state;
    if (slot.state !== undefined) {
      const fromVersion = slot.stateVersion ?? 1;
      if (fromVersion !== behavior.stateVersion) {
        if (!behavior.migrations) {
          throw new Error(
            `behavior ${behavior.behaviorType} has no migrations from state version ${fromVersion}`,
          );
        }
        if (behavior.migrations.currentVersion !== behavior.stateVersion) {
          throw new Error(
            `behavior ${behavior.behaviorType} migration target does not match state version`,
          );
        }
        state = behavior.migrations.migrate(state, fromVersion);
      }
    }
    const attached: BehaviorSlot = {
      ...slot,
      state,
      stateVersion: behavior.stateVersion,
    };
    this.slots.set(slot.entityId, attached);
    return attached;
  }

  detach(entityId: EntityId): void {
    this.slots.delete(entityId);
    this.timers.cancelAll(entityId);
  }

  slot(entityId: EntityId): BehaviorSlot | undefined {
    return this.slots.get(entityId);
  }

  setConfig(entityId: EntityId, config: unknown): boolean {
    const slot = this.slots.get(entityId);
    if (!slot) return false;
    slot.config = config;
    return true;
  }

  setDisabled(entityId: EntityId, disabled: boolean, currentTick: number): boolean {
    const slot = this.slots.get(entityId);
    if (!slot) return false;
    slot.disabled = disabled;
    this.timers.setPaused(entityId, disabled, currentTick);
    return true;
  }

  all(): BehaviorSlot[] {
    return [...this.slots.values()];
  }

  /** Queue an event for the next step. */
  emit(event: BehaviorEvent): void {
    this.queue.push(event);
  }

  emitAll(events: BehaviorEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  /**
   * Runs one behavior step for `tick`. Call it after the physics step has
   * produced collision events and before the next step applies forces.
   */
  step(tick: number): StepReport {
    const events = sortEvents([...this.queue, ...this.timers.collectDue(tick)]);
    this.queue = [];

    const pending: AppliedCommand[] = [];
    const errors: StepReport["errors"] = [];
    let eventsProcessed = 0;

    for (const event of events) {
      const slot = this.slots.get(event.self);
      if (!slot || slot.disabled) continue;
      const behavior = this.registry.get<any, any>(slot.behaviorType);
      if (!behavior) continue;
      if (behavior.subscribes && !behavior.subscribes.includes(event.type)) continue;

      const ctx = this.makeContext(slot.entityId, tick);
      try {
        const result = behavior.onEvent(ctx, slot.config, slot.state as never, event);
        slot.state = result.state;
        eventsProcessed++;
        for (const command of result.commands) {
          pending.push({ tick, entityId: slot.entityId, command });
        }
      } catch (error) {
        errors.push({ entityId: slot.entityId, error });
      }
    }

    for (const applied of pending) this.apply(applied, tick);

    return { tick, eventsProcessed, commandsApplied: pending, errors };
  }

  /** Spec 13.3. Normalize durable state and stop every timer. */
  normalizeForSleep(): void {
    for (const slot of this.slots.values()) {
      const behavior = this.registry.get<any, any>(slot.behaviorType);
      if (!behavior) continue;
      if (behavior.normalizeForSleep) {
        slot.state = behavior.normalizeForSleep(slot.config, slot.state as never);
      }
    }
    this.timers.clear();
  }

  private apply(applied: AppliedCommand, tick: number): void {
    const { command } = applied;
    const self = applied.entityId;
    const target = "target" in command && command.target ? command.target : self;

    switch (command.type) {
      case "applyForce":
        this.host.applyForce(target, command.force, command.local ?? false);
        break;
      case "applyImpulse":
        this.host.applyImpulse(target, command.impulse, command.local ?? false);
        break;
      case "applyTorque":
        this.host.applyTorque(target, command.torque);
        break;
      case "setVelocity":
        this.host.setVelocity(target, command.velocity, command.angularVelocity);
        break;
      case "setBodyMode":
        this.host.setBodyMode(target, command.mode);
        break;
      case "setColliderEnabled":
        this.host.setColliderEnabled(target, command.colliderId, command.enabled);
        break;
      case "setElevationVelocity":
        this.host.setElevationVelocity(target, command.vz);
        break;
      case "teleport":
        this.host.teleport(
          target,
          command.position,
          command.rotation,
          command.velocity,
          command.z,
        );
        break;
      case "setSpriteVariant":
        this.host.setSpriteVariant(target, command.variant, command.persistent ?? false);
        break;
      case "startAnimation":
        this.host.startAnimation(target, command.animation, command.loop ?? true);
        break;
      case "emitEffect":
        this.host.emitEffect({
          tick,
          entityId: target,
          effect: command.effect,
          mode: command.mode ?? "oneShot",
          params: command.params,
        });
        break;
      case "scheduleTimer":
        this.timers.schedule(
          self,
          command.key,
          command.seconds,
          tick,
          command.replace ?? true,
        );
        break;
      case "cancelTimer":
        this.timers.cancel(self, command.key);
        break;
      case "setState": {
        const slot = this.slots.get(self);
        if (slot) slot.state = command.state;
        break;
      }
      case "log":
        break;
    }
  }

  private makeContext(entityId: EntityId, tick: number): BehaviorContext {
    const host = this.host;
    const rng = mulberry32(hashString(entityId) ^ (tick * 0x9e3779b1));
    const tickRate = this.tickRate;
    return {
      tick,
      tickRate,
      dt: 1 / tickRate,
      self: entityId,
      canvas: this.canvas,
      transform: (target) => host.transform(target ?? entityId),
      velocity: (target) => host.velocity(target ?? entityId),
      angularVelocity: (target) => host.angularVelocity(target ?? entityId),
      elevation: (target) => host.elevation(target ?? entityId),
      contacts: (colliderId) => host.contacts(entityId, colliderId),
      tags: (target) => host.tags(target ?? entityId),
      ticksFor: (seconds) => Math.max(1, Math.round(seconds * tickRate)),
      random: rng,
    };
  }
}
