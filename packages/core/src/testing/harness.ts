import type { Vec2 } from "../math/vec2.js";
import type { BodyMode } from "../model/item-definition.js";
import type { Transform } from "../model/item-instance.js";
import type { ItemBehavior } from "../behavior/behavior.js";
import type { BehaviorCommand } from "../behavior/commands.js";
import type { BehaviorEvent, ContactParty } from "../behavior/events.js";
import type { BehaviorHost, EffectEmission } from "../behavior/host.js";
import { BehaviorRegistry } from "../behavior/registry.js";
import { BehaviorRuntime, type AppliedCommand } from "../behavior/runtime.js";
import type { CanvasContextInfo } from "../behavior/runtime.js";
import type { EntityId } from "../registry/components.js";

export interface FakeBody {
  transform: Transform;
  velocity: Vec2;
  angularVelocity: number;
  mode: BodyMode;
  elevation?: { z: number; vz: number; grounded: boolean };
  tags: string[];
  variant?: string;
  tint?: number;
  animation?: string;
  disabledColliders: Set<string>;
  forces: Vec2[];
  impulses: Vec2[];
  torques: number[];
}

const emptyBody = (transform: Partial<Transform> = {}): FakeBody => ({
  transform: { x: 0, y: 0, rotation: 0, ...transform },
  velocity: { x: 0, y: 0 },
  angularVelocity: 0,
  mode: "dynamic",
  tags: [],
  disabledColliders: new Set(),
  forces: [],
  impulses: [],
  torques: [],
});

/**
 * Spec 21.2. A headless host with no physics engine. Feed a behavior a fixed
 * sequence of events and ticks, then assert the state and the commands.
 */
export class BehaviorTestHost implements BehaviorHost {
  readonly bodies = new Map<EntityId, FakeBody>();
  readonly effects: EffectEmission[] = [];
  private readonly contactSets = new Map<string, ContactParty[]>();

  body(id: EntityId, init: Partial<Transform> = {}): FakeBody {
    let body = this.bodies.get(id);
    if (!body) {
      body = emptyBody(init);
      this.bodies.set(id, body);
    }
    return body;
  }

  setContacts(id: EntityId, colliderId: string, parties: ContactParty[]): void {
    this.contactSets.set(`${id}/${colliderId}`, parties);
  }

  transform(id: EntityId) {
    return this.bodies.get(id)?.transform;
  }
  velocity(id: EntityId) {
    return this.bodies.get(id)?.velocity;
  }
  angularVelocity(id: EntityId) {
    return this.bodies.get(id)?.angularVelocity;
  }
  elevation(id: EntityId) {
    return this.bodies.get(id)?.elevation;
  }
  contacts(id: EntityId, colliderId: string) {
    return this.contactSets.get(`${id}/${colliderId}`) ?? [];
  }
  tags(id: EntityId) {
    return this.bodies.get(id)?.tags ?? [];
  }

  applyForce(id: EntityId, force: Vec2, local: boolean): void {
    const body = this.body(id);
    body.forces.push(local ? this.toWorld(body, force) : force);
  }
  applyImpulse(id: EntityId, impulse: Vec2, local: boolean): void {
    const body = this.body(id);
    const world = local ? this.toWorld(body, impulse) : impulse;
    body.impulses.push(world);
    body.velocity = { x: body.velocity.x + world.x, y: body.velocity.y + world.y };
  }
  applyTorque(id: EntityId, torque: number): void {
    this.body(id).torques.push(torque);
  }
  setVelocity(id: EntityId, velocity?: Vec2, angularVelocity?: number): void {
    const body = this.body(id);
    if (velocity) body.velocity = { ...velocity };
    if (angularVelocity !== undefined) body.angularVelocity = angularVelocity;
  }
  setBodyMode(id: EntityId, mode: BodyMode): void {
    this.body(id).mode = mode;
  }
  setColliderEnabled(id: EntityId, colliderId: string, enabled: boolean): void {
    const body = this.body(id);
    if (enabled) body.disabledColliders.delete(colliderId);
    else body.disabledColliders.add(colliderId);
  }
  setElevationVelocity(id: EntityId, vz: number): void {
    const body = this.body(id);
    body.elevation = body.elevation ?? { z: 0, vz: 0, grounded: true };
    body.elevation.vz = vz;
    body.elevation.grounded = false;
  }
  teleport(id: EntityId, position: Vec2, rotation?: number, velocity?: Vec2, z?: number): void {
    const body = this.body(id);
    body.transform = {
      ...body.transform,
      x: position.x,
      y: position.y,
      rotation: rotation ?? body.transform.rotation,
    };
    if (z !== undefined) body.transform.z = z;
    if (velocity) body.velocity = { ...velocity };
  }
  setSpriteVariant(id: EntityId, variant: string): void {
    this.body(id).variant = variant;
  }
  setSpriteTint(id: EntityId, tint: number | undefined): void {
    this.body(id).tint = tint;
  }
  startAnimation(id: EntityId, animation: string): void {
    this.body(id).animation = animation;
  }
  emitEffect(emission: EffectEmission): void {
    this.effects.push(emission);
  }

  private toWorld(body: FakeBody, v: Vec2): Vec2 {
    const c = Math.cos(body.transform.rotation);
    const s = Math.sin(body.transform.rotation);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }
}

export interface HarnessOptions {
  canvas?: Partial<CanvasContextInfo>;
  tickRate?: number;
  entityId?: EntityId;
}

export class BehaviorTestHarness<Config, State> {
  readonly host = new BehaviorTestHost();
  readonly registry = new BehaviorRegistry();
  readonly runtime: BehaviorRuntime;
  readonly entityId: EntityId;
  private currentTick = 0;
  readonly commandLog: AppliedCommand[] = [];

  constructor(
    behavior: ItemBehavior<Config, State>,
    readonly config: Config,
    options: HarnessOptions = {},
  ) {
    this.entityId = options.entityId ?? "item-1";
    this.registry.register(behavior);
    this.runtime = new BehaviorRuntime(
      this.registry,
      this.host,
      {
        id: "test-canvas",
        width: 100,
        height: 70,
        orientation: "side",
        ...options.canvas,
      },
      options.tickRate ?? 60,
    );
    this.host.body(this.entityId);
    this.runtime.attach({
      entityId: this.entityId,
      behaviorType: behavior.behaviorType,
      config,
      persistent: true,
    });
  }

  get tick(): number {
    return this.currentTick;
  }

  get state(): State {
    return this.runtime.slot(this.entityId)!.state as State;
  }

  /** Queue an event for the current tick. Fields default to this entity. */
  send(event: Partial<BehaviorEvent> & { type: BehaviorEvent["type"] }): this {
    this.runtime.emit({
      tick: this.currentTick,
      self: this.entityId,
      ...event,
    } as BehaviorEvent);
    return this;
  }

  /** Run `count` simulation ticks. Each tick delivers a tick event. */
  advance(count = 1, withTickEvent = true): this {
    for (let i = 0; i < count; i++) {
      this.currentTick++;
      if (withTickEvent) {
        this.runtime.emit({
          type: "tick",
          tick: this.currentTick,
          self: this.entityId,
          dt: 1 / this.runtime.timers.ticksFor(1),
        });
      }
      const report = this.runtime.step(this.currentTick);
      this.commandLog.push(...report.commandsApplied);
      if (report.errors.length > 0) throw report.errors[0]!.error;
    }
    return this;
  }

  /** Advance for a number of seconds of simulation time. */
  advanceSeconds(seconds: number, withTickEvent = true): this {
    return this.advance(this.runtime.timers.ticksFor(seconds), withTickEvent);
  }

  /** Deliver queued events without advancing the tick counter. */
  flush(): this {
    const report = this.runtime.step(this.currentTick);
    this.commandLog.push(...report.commandsApplied);
    if (report.errors.length > 0) throw report.errors[0]!.error;
    return this;
  }

  commands<T extends BehaviorCommand["type"]>(
    type: T,
  ): Extract<BehaviorCommand, { type: T }>[];
  commands(): BehaviorCommand[];
  commands(type?: BehaviorCommand["type"]): BehaviorCommand[] {
    const all = this.commandLog.map((entry) => entry.command);
    return type ? all.filter((command) => command.type === type) : all;
  }

  effects(name?: string): EffectEmission[] {
    return name
      ? this.host.effects.filter((effect) => effect.effect === name)
      : this.host.effects;
  }
}

export const avatarParty = (
  entityId: string,
  userId = entityId,
  tags: string[] = [],
): ContactParty => ({ entityId, colliderId: "body", kind: "avatar", tags, userId });

export const staticParty = (
  entityId: string,
  tags: string[] = [],
): ContactParty => ({ entityId, colliderId: "solid", kind: "static", tags });
