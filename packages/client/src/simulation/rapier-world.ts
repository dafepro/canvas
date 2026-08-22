import RAPIER from "@dimforge/rapier2d-compat";
import {
  EnvironmentField,
  isSensorRole,
  resolveEdges,
  roleDefaultMask,
  roleMembership,
  softSpeedLimitForce,
  stepElevation,
  type BehaviorEvent,
  type BehaviorHost,
  type BodyMode,
  type CanvasDefinition,
  type ColliderDefinition,
  type ContactParty,
  type EffectEmission,
  type Entity,
  type EntityId,
  type EnvironmentSample,
  type ItemDefinition,
  type ItemInstance,
  type ShapeDefinition,
  type Transform,
  type Vec2,
  EntityRegistry,
} from "@canvas-physics/core";

export interface AvatarSpawn {
  entityId: EntityId;
  clientId: string;
  userId: string;
  position: Vec2;
  radius?: number;
  maxSpeed?: number;
  acceleration?: number;
}

interface BodyRecord {
  entity: Entity;
  body: RAPIER.RigidBody;
  colliders: Map<string, RAPIER.Collider>;
  /** Region ids the body was inside on the previous tick. */
  regions: Set<string>;
}

interface ContactRecord {
  selfId: EntityId;
  selfColliderId: string;
  other: ContactParty;
  startTick: number;
}

/** The direction a wrapped body travels, away from the edge it arrived at. */
const inwardOf = (edge: "top" | "right" | "bottom" | "left"): Vec2 => {
  switch (edge) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
};

const collisionGroups = (membership: number, filter: number): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

/**
 * The canonical physics world. Only the simulation host runs a full one; a
 * normal client runs a prediction world with static geometry and its own
 * avatar (spec 15.2).
 */
export class RapierWorld implements BehaviorHost {
  readonly registry = new EntityRegistry();
  readonly environment: EnvironmentField;
  private readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  private readonly characterController: RAPIER.KinematicCharacterController;
  private readonly bodies = new Map<EntityId, BodyRecord>();
  private readonly colliderOwner = new Map<number, { entityId: EntityId; colliderId: string }>();
  private readonly contactSets = new Map<string, ContactRecord>();
  private readonly definitions = new Map<string, ItemDefinition>();
  private readonly sample: EnvironmentSample;
  private readonly pendingEvents: BehaviorEvent[] = [];
  private readonly pendingEffects: EffectEmission[] = [];
  private tick = 0;

  static async load(): Promise<void> {
    await RAPIER.init();
  }

  constructor(
    readonly canvas: CanvasDefinition,
    definitions: ItemDefinition[],
    readonly tickRate = 60,
  ) {
    for (const definition of definitions) {
      this.definitions.set(definition.definitionId, definition);
    }
    this.environment = new EnvironmentField(canvas.environment);
    // Gravity is sampled for each body, so the world itself has none.
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = 1 / tickRate;
    this.events = new RAPIER.EventQueue(true);
    // Spec 6.1. The avatar is a kinematic body, so the solver never stops it.
    // The character controller clamps each move against solid geometry and
    // slides the rest along the surface.
    this.characterController = this.world.createCharacterController(0.02);
    this.characterController.setUp({ x: 0, y: -1 });
    this.characterController.setSlideEnabled(true);
    // Every surface is climbable. This canvas has no walk cycle, so a steep
    // surface must slide rather than stop the avatar.
    this.characterController.setMaxSlopeClimbAngle(Math.PI);
    this.characterController.setMinSlopeSlideAngle(0);
    this.sample = this.environment.sample({ x: 0, y: 0 });
    this.buildStaticGeometry();
  }

  get currentTick(): number {
    return this.tick;
  }

  /** Spec 22.1 and 19.1. The collider budget is 150 for a whole scene. */
  get activeColliderCount(): number {
    let count = 0;
    for (const record of this.bodies.values()) {
      for (const collider of record.colliders.values()) {
        if (collider.isEnabled()) count++;
      }
    }
    return count;
  }

  free(): void {
    this.world.free();
    this.events.free();
  }

  // ---------- construction ----------

  private buildStaticGeometry(): void {
    for (const definition of this.canvas.staticGeometry) {
      const role = definition.role ?? "worldStatic";
      const entity: Entity = {
        id: `static:${definition.id}`,
        kind: "static",
        transform: {
          x: definition.position.x,
          y: definition.position.y,
          rotation: definition.rotation ?? 0,
        },
        tags: new Set(definition.tags ?? []),
      };
      this.registry.add(entity);

      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(definition.position.x, definition.position.y)
          .setRotation(definition.rotation ?? 0),
      );
      const record: BodyRecord = {
        entity,
        body,
        colliders: new Map(),
        regions: new Set(),
      };
      this.bodies.set(entity.id, record);
      this.attachCollider(record, {
        id: definition.id,
        role,
        shape: definition.shape,
        restitution: definition.restitution,
        friction: definition.friction,
        tags: definition.tags,
      });
    }

    // Solid edges become fixed colliders so bodies cannot leave.
    const { width, height } = this.canvas.size;
    const thickness = Math.max(width, height) * 0.1;
    const edges: [keyof CanvasDefinition["edges"], Vec2, Vec2][] = [
      ["left", { x: -thickness / 2, y: height / 2 }, { x: thickness, y: height * 3 }],
      ["right", { x: width + thickness / 2, y: height / 2 }, { x: thickness, y: height * 3 }],
      ["top", { x: width / 2, y: -thickness / 2 }, { x: width * 3, y: thickness }],
      ["bottom", { x: width / 2, y: height + thickness / 2 }, { x: width * 3, y: thickness }],
    ];
    for (const [edge, centre, size] of edges) {
      if (this.canvas.edges[edge] !== "solid") continue;
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(centre.x, centre.y),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2).setCollisionGroups(
          collisionGroups(roleMembership.worldStatic, roleDefaultMask.worldStatic),
        ),
        body,
      );
      this.colliderOwner.set(collider.handle, {
        entityId: `edge:${edge}`,
        colliderId: edge,
      });
      const entity: Entity = {
        id: `edge:${edge}`,
        kind: "static",
        transform: { x: centre.x, y: centre.y, rotation: 0 },
        tags: new Set(["edge", "ground"]),
      };
      this.registry.add(entity);
      this.bodies.set(entity.id, {
        entity,
        body,
        colliders: new Map([[edge, collider]]),
        regions: new Set(),
      });
    }
  }

  private shapeDesc(shape: ShapeDefinition): RAPIER.ColliderDesc {
    switch (shape.type) {
      case "circle":
        return RAPIER.ColliderDesc.ball(shape.radius);
      case "rect":
        return RAPIER.ColliderDesc.cuboid(shape.width / 2, shape.height / 2);
      case "capsule":
        return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      case "polygon": {
        const points = new Float32Array(shape.vertices.length * 2);
        shape.vertices.forEach((vertex, i) => {
          points[i * 2] = vertex.x;
          points[i * 2 + 1] = vertex.y;
        });
        return (
          RAPIER.ColliderDesc.convexHull(points) ??
          RAPIER.ColliderDesc.ball(0.5)
        );
      }
    }
  }

  private attachCollider(record: BodyRecord, definition: ColliderDefinition): void {
    const desc = this.shapeDesc(definition.shape);
    const membership = definition.membership ?? roleMembership[definition.role];
    const filter = definition.collisionMask ?? roleDefaultMask[definition.role];
    const sensor = definition.sensor ?? isSensorRole(definition.role);

    desc
      .setSensor(sensor)
      .setCollisionGroups(collisionGroups(membership, filter))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (definition.offset) {
      desc.setTranslation(definition.offset.x, definition.offset.y);
    }
    if (definition.rotation !== undefined) desc.setRotation(definition.rotation);
    if (definition.restitution !== undefined) desc.setRestitution(definition.restitution);
    if (definition.friction !== undefined) desc.setFriction(definition.friction);
    if (definition.density !== undefined) desc.setDensity(definition.density);

    const collider = this.world.createCollider(desc, record.body);
    if (definition.enabled === false) collider.setEnabled(false);
    record.colliders.set(definition.id, collider);
    this.colliderOwner.set(collider.handle, {
      entityId: record.entity.id,
      colliderId: definition.id,
    });
    record.entity.colliders = record.entity.colliders ?? [];
    record.entity.colliders.push({ ...definition, handle: collider.handle });
  }

  private bodyDesc(mode: BodyMode, transform: Transform): RAPIER.RigidBodyDesc {
    const desc =
      mode === "fixed"
        ? RAPIER.RigidBodyDesc.fixed()
        : mode === "dynamic"
          ? RAPIER.RigidBodyDesc.dynamic()
          : mode === "kinematicPosition"
            ? RAPIER.RigidBodyDesc.kinematicPositionBased()
            : RAPIER.RigidBodyDesc.kinematicVelocityBased();
    return desc.setTranslation(transform.x, transform.y).setRotation(transform.rotation);
  }

  /** Adds an item instance and returns the entity it created. */
  addItem(instance: ItemInstance): Entity | undefined {
    const definition = this.definitions.get(instance.definitionId);
    if (!definition) return undefined;
    if (this.bodies.has(instance.entityId)) this.removeEntity(instance.entityId);

    const mode: BodyMode = definition.body?.mode ?? "fixed";
    const entity: Entity = {
      id: instance.entityId,
      kind: "item",
      transform: { ...instance.transform },
      render: {
        definitionId: definition.definitionId,
        zIndex: definition.visual.zIndex ?? 0,
        size: definition.visual.size,
      },
      ownership: { ownerUserId: instance.ownerUserId },
      persistence: definition.persistence,
      tags: new Set([definition.definitionId]),
    };

    const body = this.world.createRigidBody(this.bodyDesc(mode, instance.transform));
    if (definition.body) {
      if (definition.body.gravityScale !== undefined) {
        body.setGravityScale(definition.body.gravityScale, true);
      }
      if (definition.body.linearDamping !== undefined) {
        body.setLinearDamping(definition.body.linearDamping);
      }
      if (definition.body.angularDamping !== undefined) {
        body.setAngularDamping(definition.body.angularDamping);
      }
      if (definition.body.lockRotation) body.lockRotations(true, true);
      if (definition.body.canSleep === false) body.wakeUp();
    }

    entity.rigidBody = {
      mode,
      velocity: { x: 0, y: 0 },
      angularVelocity: 0,
      gravityScale: definition.body?.gravityScale ?? 1,
      mass: definition.body?.mass ?? body.mass(),
      awake: true,
    };
    if (definition.elevation?.enabled) {
      entity.elevation = {
        ...definition.elevation,
        z: instance.transform.z ?? definition.elevation.groundZ ?? 0,
        vz: 0,
        grounded: true,
      };
    }
    if (definition.behaviorType) {
      entity.behavior = {
        behaviorType: definition.behaviorType,
        config: instance.resolvedConfig,
        state: instance.behaviorState,
        stateVersion: 1,
        persistent: definition.persistence.behaviorState,
      };
    }

    this.registry.add(entity);
    const record: BodyRecord = { entity, body, colliders: new Map(), regions: new Set() };
    this.bodies.set(entity.id, record);
    for (const collider of definition.colliders) this.attachCollider(record, collider);
    return entity;
  }

  addAvatar(spawn: AvatarSpawn): Entity {
    const radius = spawn.radius ?? 1.2;
    const entity: Entity = {
      id: spawn.entityId,
      kind: "avatar",
      transform: { x: spawn.position.x, y: spawn.position.y, rotation: 0 },
      avatar: {
        userId: spawn.userId,
        clientId: spawn.clientId,
        radius,
        maxSpeed: spawn.maxSpeed ?? 18,
        acceleration: spawn.acceleration ?? 90,
        lastProcessedInputSeq: 0,
        desiredDirection: { x: 0, y: 0 },
        desiredIntensity: 0,
      },
      render: { definitionId: "avatar", zIndex: 10, size: { width: radius * 2, height: radius * 2 } },
      tags: new Set(["avatar"]),
    };
    this.registry.add(entity);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(
        spawn.position.x,
        spawn.position.y,
      ),
    );
    const record: BodyRecord = { entity, body, colliders: new Map(), regions: new Set() };
    this.bodies.set(entity.id, record);
    // Spec 5.3. A solid body circle plus a larger interaction sensor.
    this.attachCollider(record, {
      id: "body",
      role: "avatarBody",
      shape: { type: "circle", radius },
    });
    this.attachCollider(record, {
      id: "sensor",
      role: "avatarSensor",
      shape: { type: "circle", radius: radius * 1.6 },
    });
    return entity;
  }

  removeEntity(entityId: EntityId): void {
    const record = this.bodies.get(entityId);
    if (!record) return;
    for (const [, collider] of record.colliders) {
      this.colliderOwner.delete(collider.handle);
    }
    this.world.removeRigidBody(record.body);
    this.bodies.delete(entityId);
    this.registry.remove(entityId);
    for (const [key, contact] of this.contactSets) {
      if (contact.selfId === entityId || contact.other.entityId === entityId) {
        this.contactSets.delete(key);
      }
    }
  }

  // ---------- input ----------

  /**
   * Addendum A1. A disabled avatar keeps its place but takes no part in the
   * simulation. Its colliders are switched off, so no body touches it and it
   * emits no contact, region, or dwell event.
   */
  setAvatarDisabled(entityId: EntityId, disabled: boolean): void {
    const record = this.bodies.get(entityId);
    const avatar = record?.entity.avatar;
    if (!record || !avatar) return;
    if (avatar.disabled === disabled) return;
    avatar.disabled = disabled;
    for (const collider of record.colliders.values()) collider.setEnabled(!disabled);
    if (disabled) {
      record.body.setLinvel({ x: 0, y: 0 }, true);
      record.body.setAngvel(0, true);
      avatar.desiredDirection = { x: 0, y: 0 };
      avatar.desiredIntensity = 0;
      // A contact that was open when the avatar was disabled must end, or a
      // behavior that counts avatars keeps counting this one. A disabled
      // collider raises no stop event, so the exit is emitted here.
      this.endContacts(entityId);
    }
  }

  private endContacts(entityId: EntityId): void {
    const touched: [EntityId, string][] = [];
    for (const [key, contact] of this.contactSets) {
      if (contact.selfId !== entityId && contact.other.entityId !== entityId) continue;
      this.contactSets.delete(key);
      this.pendingEvents.push({
        type: "contact.exit",
        tick: this.tick,
        self: contact.selfId,
        selfColliderId: contact.selfColliderId,
        other: contact.other,
        dwellTicks: this.tick - contact.startTick,
      });
      touched.push([contact.selfId, contact.selfColliderId]);
    }
    for (const [id, colliderId] of touched) this.emitContactCount(id, colliderId);
  }

  setAvatarInput(
    entityId: EntityId,
    direction: Vec2,
    intensity: number,
    inputSequence: number,
  ): void {
    const entity = this.registry.get(entityId);
    if (!entity?.avatar) return;
    if (entity.avatar.disabled) {
      entity.avatar.desiredDirection = { x: 0, y: 0 };
      entity.avatar.desiredIntensity = 0;
      return;
    }
    entity.avatar.desiredDirection = direction;
    entity.avatar.desiredIntensity = Math.max(0, Math.min(1, intensity));
    if (inputSequence > entity.avatar.lastProcessedInputSeq) {
      entity.avatar.lastProcessedInputSeq = inputSequence;
    }
  }

  // ---------- stepping ----------

  /** Runs one fixed step and returns the behavior events it produced. */
  step(): { tick: number; events: BehaviorEvent[] } {
    this.tick++;
    const dt = 1 / this.tickRate;

    for (const record of this.bodies.values()) {
      this.applyEnvironment(record);
      this.driveAvatar(record, dt);
    }

    this.world.step(this.events);
    this.readTransforms();
    this.collectCollisionEvents();
    this.collectRegionEvents();
    this.collectDwellEvents();
    this.stepElevations(dt);
    this.applyEdgePolicies();
    this.quarantineInvalid();

    const events = [...this.pendingEvents];
    this.pendingEvents.length = 0;
    return { tick: this.tick, events };
  }

  private applyEnvironment(record: BodyRecord): void {
    const entity = record.entity;
    if (entity.kind === "static" || !entity.rigidBody) return;
    if (entity.rigidBody.mode !== "dynamic") return;
    if (entity.quarantined) return;
    // Spec 19.2, rule 3. A sleeping body receives no impulse. Applying gravity
    // to a body at rest on the ground would wake it on every tick, so nothing
    // in the scene would ever sleep and every delta would carry every item.
    if (record.body.isSleeping()) return;

    const position = record.body.translation();
    this.environment.sample(position, this.sample);
    const mass = record.body.mass() || 1;
    const gravityScale = entity.rigidBody.gravityScale;
    const dt = 1 / this.tickRate;

    // Every environment force is applied as a one-tick impulse. A Rapier force
    // added with addForce persists until it is reset, which would accumulate
    // gravity across ticks.
    this.impulse(record, {
      x: this.sample.gravityXY.x * mass * gravityScale * dt,
      y: this.sample.gravityXY.y * mass * gravityScale * dt,
    });

    const velocity = record.body.linvel();
    if (this.sample.linearDrag > 0) {
      this.impulse(record, {
        x: -velocity.x * this.sample.linearDrag * mass * dt,
        y: -velocity.y * this.sample.linearDrag * mass * dt,
      });
    }
    if (this.sample.angularDrag > 0) {
      record.body.applyTorqueImpulse(
        -record.body.angvel() * this.sample.angularDrag * mass * dt,
        false,
      );
    }
    const limitForce = softSpeedLimitForce(velocity, this.sample.softSpeedLimit);
    if (limitForce.x !== 0 || limitForce.y !== 0) {
      this.impulse(record, {
        x: limitForce.x * mass * dt,
        y: limitForce.y * mass * dt,
      });
    }
  }

  private impulse(record: BodyRecord, impulse: Vec2): void {
    if (impulse.x === 0 && impulse.y === 0) return;
    // The body is awake already; see applyEnvironment. Waking it here would
    // defeat the sleep rule of spec 19.2.
    record.body.applyImpulse(impulse, false);
  }

  private driveAvatar(record: BodyRecord, dt: number): void {
    const avatar = record.entity.avatar;
    if (!avatar) return;
    if (avatar.disabled) {
      record.body.setLinvel({ x: 0, y: 0 }, true);
      return;
    }
    // Spec 6.1. Intent accelerates the avatar toward a desired velocity.
    const desired = {
      x: avatar.desiredDirection.x * avatar.desiredIntensity * avatar.maxSpeed,
      y: avatar.desiredDirection.y * avatar.desiredIntensity * avatar.maxSpeed,
    };
    const current = record.body.linvel();
    const maxChange = avatar.acceleration * dt;
    const deltaX = desired.x - current.x;
    const deltaY = desired.y - current.y;
    const distance = Math.hypot(deltaX, deltaY);
    const scale = distance > maxChange && distance > 0 ? maxChange / distance : 1;
    const next = { x: current.x + deltaX * scale, y: current.y + deltaY * scale };
    record.body.setLinvel(this.clampAgainstGeometry(record, next, dt), true);
  }

  /**
   * Spec 6.1. Returns the part of the velocity that solid geometry allows. A
   * kinematic body moves by its velocity alone, so without this step the avatar
   * travels through the ground and through a solid edge.
   */
  private clampAgainstGeometry(record: BodyRecord, velocity: Vec2, dt: number): Vec2 {
    const collider = record.colliders.get("body");
    if (!collider) return velocity;
    if (velocity.x === 0 && velocity.y === 0) return velocity;
    // Only a fixed collider stops the avatar. An item is dynamic and the solver
    // pushes it; another avatar is kinematic and never blocks. A filter
    // predicate is not used here: in rapier2d-compat 0.20 a predicate that sees
    // a collision leaves a Rust borrow open, and `World.free` then throws.
    this.characterController.computeColliderMovement(
      collider,
      { x: velocity.x * dt, y: velocity.y * dt },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS |
        RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC |
        RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    const moved = this.characterController.computedMovement();
    return { x: moved.x / dt, y: moved.y / dt };
  }

  private readTransforms(): void {
    for (const record of this.bodies.values()) {
      const position = record.body.translation();
      const entity = record.entity;
      entity.transform.x = position.x;
      entity.transform.y = position.y;
      entity.transform.rotation = record.body.rotation();
      if (entity.rigidBody) {
        const velocity = record.body.linvel();
        entity.rigidBody.velocity.x = velocity.x;
        entity.rigidBody.velocity.y = velocity.y;
        entity.rigidBody.angularVelocity = record.body.angvel();
        entity.rigidBody.awake = !record.body.isSleeping();
      }
      if (entity.avatar) {
        const velocity = record.body.linvel();
        entity.transform.rotation =
          velocity.x === 0 && velocity.y === 0
            ? entity.transform.rotation
            : Math.atan2(velocity.y, velocity.x);
      }
    }
  }

  private partyFor(entityId: EntityId, colliderId: string): ContactParty | undefined {
    const entity = this.registry.get(entityId);
    if (!entity) return undefined;
    const party: ContactParty = {
      entityId,
      colliderId,
      kind: entity.kind,
      tags: [...(entity.tags ?? [])],
    };
    if (entity.avatar) party.userId = entity.avatar.userId;
    return party;
  }

  private collectCollisionEvents(): void {
    this.events.drainCollisionEvents((handle1, handle2, started) => {
      const first = this.colliderOwner.get(handle1);
      const second = this.colliderOwner.get(handle2);
      if (!first || !second) return;
      this.recordContact(first, second, started);
      this.recordContact(second, first, started);
    });

    this.events.drainContactForceEvents((event) => {
      const first = this.colliderOwner.get(event.collider1());
      const second = this.colliderOwner.get(event.collider2());
      if (!first || !second) return;
      const magnitude = event.totalForceMagnitude();
      if (magnitude <= 0) return;
      const direction = event.maxForceDirection();
      for (const [self, other] of [
        [first, second],
        [second, first],
      ] as const) {
        const party = this.partyFor(other.entityId, other.colliderId);
        if (!party) continue;
        this.pendingEvents.push({
          type: "bounce",
          tick: this.tick,
          self: self.entityId,
          selfColliderId: self.colliderId,
          other: party,
          normal: { x: direction.x, y: direction.y },
          relativeSpeed: magnitude,
        });
      }
    });
  }

  private recordContact(
    self: { entityId: EntityId; colliderId: string },
    other: { entityId: EntityId; colliderId: string },
    started: boolean,
  ): void {
    const key = `${self.entityId}/${self.colliderId}|${other.entityId}/${other.colliderId}`;
    const party = this.partyFor(other.entityId, other.colliderId);
    if (!party) return;

    if (started) {
      this.contactSets.set(key, {
        selfId: self.entityId,
        selfColliderId: self.colliderId,
        other: party,
        startTick: this.tick,
      });
      this.pendingEvents.push({
        type: "contact.enter",
        tick: this.tick,
        self: self.entityId,
        selfColliderId: self.colliderId,
        other: party,
      });
    } else {
      const record = this.contactSets.get(key);
      this.contactSets.delete(key);
      this.pendingEvents.push({
        type: "contact.exit",
        tick: this.tick,
        self: self.entityId,
        selfColliderId: self.colliderId,
        other: party,
        dwellTicks: record ? this.tick - record.startTick : 0,
      });
    }
    this.emitContactCount(self.entityId, self.colliderId);
  }

  private emitContactCount(entityId: EntityId, colliderId: string): void {
    const parties = this.contactsOf(entityId, colliderId);
    const key = `${entityId}/${colliderId}`;
    const before = this.lastCounts.get(key) ?? 0;
    if (before === parties.length) return;
    this.lastCounts.set(key, parties.length);
    this.pendingEvents.push({
      type: "contact.count",
      tick: this.tick,
      self: entityId,
      colliderId,
      count: parties.length,
      previousCount: before,
      parties,
    });
  }

  private readonly lastCounts = new Map<string, number>();

  private contactsOf(entityId: EntityId, colliderId: string): ContactParty[] {
    const parties: ContactParty[] = [];
    for (const record of this.contactSets.values()) {
      if (record.selfId === entityId && record.selfColliderId === colliderId) {
        parties.push(record.other);
      }
    }
    return parties;
  }

  private collectDwellEvents(): void {
    for (const record of this.contactSets.values()) {
      this.pendingEvents.push({
        type: "contact.stay",
        tick: this.tick,
        self: record.selfId,
        selfColliderId: record.selfColliderId,
        other: record.other,
        dwellTicks: this.tick - record.startTick,
      });
    }
  }

  private collectRegionEvents(): void {
    const emitting = new Map(
      this.canvas.regions
        .filter((region) => region.emitEvents !== false)
        .map((region) => [region.id, region]),
    );
    if (emitting.size === 0) return;

    for (const record of this.bodies.values()) {
      if (record.entity.kind === "static") continue;
      const position = record.entity.transform;
      const inside = new Set<string>();
      // A disabled avatar belongs to no region, so the loop below emits the
      // exit for every region it was in.
      for (const [id, region] of record.entity.avatar?.disabled ? [] : emitting) {
        const shape = region.shape;
        const contained =
          shape.type === "rect"
            ? position.x >= shape.x &&
              position.x <= shape.x + shape.w &&
              position.y >= shape.y &&
              position.y <= shape.y + shape.h
            : Math.hypot(position.x - shape.x, position.y - shape.y) <= shape.radius;
        if (contained) inside.add(id);
      }

      for (const id of inside) {
        if (record.regions.has(id)) continue;
        this.pendingEvents.push({
          type: "region.enter",
          tick: this.tick,
          self: record.entity.id,
          regionId: id,
          tags: emitting.get(id)?.tags ?? [],
        });
      }
      for (const id of record.regions) {
        if (inside.has(id)) continue;
        this.pendingEvents.push({
          type: "region.exit",
          tick: this.tick,
          self: record.entity.id,
          regionId: id,
          tags: emitting.get(id)?.tags ?? [],
          velocity: record.entity.rigidBody?.velocity ?? { x: 0, y: 0 },
        });
      }
      record.regions = inside;
    }
  }

  private stepElevations(dt: number): void {
    for (const record of this.bodies.values()) {
      const elevation = record.entity.elevation;
      if (!elevation?.enabled) continue;
      if (record.entity.avatar?.disabled) continue;
      this.environment.sample(record.entity.transform, this.sample);
      const result = stepElevation(elevation, this.sample, dt);
      record.entity.transform.z = elevation.z;
      if (result.landed) {
        this.pendingEvents.push({
          type: "landing",
          tick: this.tick,
          self: record.entity.id,
          impactSpeed: result.impactSpeed,
        });
      }
    }
  }

  private applyEdgePolicies(): void {
    for (const record of this.bodies.values()) {
      if (record.entity.kind === "static") continue;
      if (record.entity.avatar?.disabled) continue;
      const transform = record.entity.transform;
      const velocity = record.body.linvel();
      const radius = record.entity.avatar?.radius ?? 0;
      const resolution = resolveEdges(this.canvas, transform, velocity, radius);
      if (resolution.crossings.length === 0) continue;
      if (resolution.position) {
        const wrapped = resolution.crossings.find((crossing) => crossing.policy === "wrap");
        const target = wrapped
          ? this.clearOfGeometry(record, resolution.position, inwardOf(wrapped.edge))
          : resolution.position;
        record.body.setTranslation(target, true);
        transform.x = target.x;
        transform.y = target.y;
      }
      if (resolution.velocity) {
        record.body.setLinvel(resolution.velocity, true);
        record.body.setAngvel(0, true);
      }
    }
  }

  /**
   * Spec 3.2. A wrapped body must arrive in free space. The opposite edge of the
   * rocket canvas is behind the ground, so a wrap without this step leaves the
   * body inside the terrain, where it sticks or falls out of the canvas.
   */
  private clearOfGeometry(record: BodyRecord, position: Vec2, inward: Vec2): Vec2 {
    const radius = Math.max(record.entity.avatar?.radius ?? 0, 0.75);
    const shape = new RAPIER.Ball(radius);
    const step = radius;
    const limit = Math.ceil(
      Math.max(this.canvas.size.width, this.canvas.size.height) / 2 / step,
    );
    let probe = { ...position };
    for (let i = 0; i <= limit; i++) {
      const hit = this.world.intersectionWithShape(
        probe,
        0,
        shape,
        undefined,
        undefined,
        undefined,
        record.body,
        (collider) => !collider.isSensor(),
      );
      if (!hit) return probe;
      probe = { x: probe.x + inward.x * step, y: probe.y + inward.y * step };
    }
    return position;
  }

  /** Spec 14.3 and 20. A NaN entity is quarantined rather than crashing the room. */
  private quarantineInvalid(): void {
    for (const record of this.bodies.values()) {
      const transform = record.entity.transform;
      if (
        Number.isFinite(transform.x) &&
        Number.isFinite(transform.y) &&
        Number.isFinite(transform.rotation)
      ) {
        continue;
      }
      record.entity.quarantined = true;
      const spawn = this.canvas.spawnPoints[0]?.position ?? {
        x: this.canvas.size.width / 2,
        y: this.canvas.size.height / 2,
      };
      record.body.setTranslation(spawn, true);
      record.body.setLinvel({ x: 0, y: 0 }, true);
      record.body.setAngvel(0, true);
      transform.x = spawn.x;
      transform.y = spawn.y;
      transform.rotation = 0;
    }
  }

  // ---------- BehaviorHost ----------

  transform(id: EntityId): Readonly<Transform> | undefined {
    return this.registry.get(id)?.transform;
  }

  velocity(id: EntityId): Readonly<Vec2> | undefined {
    const record = this.bodies.get(id);
    if (!record) return undefined;
    const velocity = record.body.linvel();
    return { x: velocity.x, y: velocity.y };
  }

  angularVelocity(id: EntityId): number | undefined {
    return this.bodies.get(id)?.body.angvel();
  }

  elevation(id: EntityId): { z: number; vz: number; grounded: boolean } | undefined {
    const elevation = this.registry.get(id)?.elevation;
    if (!elevation) return undefined;
    return { z: elevation.z, vz: elevation.vz, grounded: elevation.grounded };
  }

  contacts(id: EntityId, colliderId: string): readonly ContactParty[] {
    return this.contactsOf(id, colliderId);
  }

  tags(id: EntityId): readonly string[] {
    return [...(this.registry.get(id)?.tags ?? [])];
  }

  private localToWorld(id: EntityId, vector: Vec2): Vec2 {
    const rotation = this.registry.get(id)?.transform.rotation ?? 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
  }

  /**
   * Applies a force for the duration of one tick. Behaviors run after the
   * physics step, so the impulse takes effect on the next step.
   */
  applyForce(id: EntityId, force: Vec2, local: boolean): void {
    const record = this.bodies.get(id);
    if (!record) return;
    const world = local ? this.localToWorld(id, force) : force;
    const mass = record.body.mass() || 1;
    const dt = 1 / this.tickRate;
    record.body.applyImpulse({ x: world.x * mass * dt, y: world.y * mass * dt }, true);
  }

  applyImpulse(id: EntityId, impulse: Vec2, local: boolean): void {
    const record = this.bodies.get(id);
    if (!record) return;
    const world = local ? this.localToWorld(id, impulse) : impulse;
    const mass = record.body.mass() || 1;
    record.body.applyImpulse({ x: world.x * mass, y: world.y * mass }, true);
  }

  applyTorque(id: EntityId, torque: number): void {
    const record = this.bodies.get(id);
    if (!record) return;
    record.body.applyTorqueImpulse(torque / this.tickRate, true);
  }

  setVelocity(id: EntityId, velocity?: Vec2, angularVelocity?: number): void {
    const record = this.bodies.get(id);
    if (!record) return;
    if (velocity) record.body.setLinvel(velocity, true);
    if (angularVelocity !== undefined) record.body.setAngvel(angularVelocity, true);
  }

  setBodyMode(id: EntityId, mode: BodyMode): void {
    const record = this.bodies.get(id);
    if (!record) return;
    const bodyType =
      mode === "fixed"
        ? RAPIER.RigidBodyType.Fixed
        : mode === "dynamic"
          ? RAPIER.RigidBodyType.Dynamic
          : mode === "kinematicPosition"
            ? RAPIER.RigidBodyType.KinematicPositionBased
            : RAPIER.RigidBodyType.KinematicVelocityBased;
    record.body.setBodyType(bodyType, true);
    if (record.entity.rigidBody) record.entity.rigidBody.mode = mode;
  }

  setColliderEnabled(id: EntityId, colliderId: string, enabled: boolean): void {
    this.bodies.get(id)?.colliders.get(colliderId)?.setEnabled(enabled);
  }

  setElevationVelocity(id: EntityId, vz: number): void {
    const elevation = this.registry.get(id)?.elevation;
    if (!elevation) return;
    elevation.vz = vz;
    elevation.grounded = false;
  }

  teleport(
    id: EntityId,
    position: Vec2,
    rotation?: number,
    velocity?: Vec2,
    z?: number,
  ): void {
    const record = this.bodies.get(id);
    if (!record) return;
    record.body.setTranslation(position, true);
    if (rotation !== undefined) record.body.setRotation(rotation, true);
    if (velocity) record.body.setLinvel(velocity, true);
    record.entity.transform.x = position.x;
    record.entity.transform.y = position.y;
    if (rotation !== undefined) record.entity.transform.rotation = rotation;
    if (z !== undefined && record.entity.elevation) {
      record.entity.elevation.z = z;
      record.entity.transform.z = z;
    }
  }

  setSpriteVariant(id: EntityId, variant: string): void {
    const render = this.registry.get(id)?.render;
    if (render) render.variant = variant;
  }

  startAnimation(id: EntityId, animation: string): void {
    const render = this.registry.get(id)?.render;
    if (render) render.animation = animation;
  }

  emitEffect(emission: EffectEmission): void {
    this.pendingEffects.push(emission);
  }

  /** Drains the effects the behaviors emitted during the step. */
  drainEffects(): EffectEmission[] {
    const effects = [...this.pendingEffects];
    this.pendingEffects.length = 0;
    return effects;
  }
}
