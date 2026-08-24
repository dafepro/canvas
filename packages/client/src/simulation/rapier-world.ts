import RAPIER from "@dimforge/rapier2d-compat";
import {
  EnvironmentField,
  isSensorRole,
  defaultRespawnPolicy,
  resolveAvatarController,
  resolveEdges,
  resolveTerrainBlocking,
  roleDefaultMask,
  roleMembership,
  terrainMask,
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
  type RespawnPolicy,
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
  /** Consecutive ticks the body spent still and inside fixed geometry. */
  stuckTicks?: number;
  /**
   * Addendum A4. The collision groups of the solid collider. A shape query uses
   * them, so a probe ignores the terrain that lets this body pass through.
   */
  queryGroups?: number;
  /** Addendum A3. Ticks left before the body returns to the canvas. */
  respawnTicks?: number;
  /** Addendum A3. Colliders switched off for the wait, to switch back on. */
  respawnDisabled?: string[];
}

/** Spec 20. Half a second at 60 Hz before a still, embedded body is freed. */
const STUCK_TICKS = 30;
/** Below this speed a body is treated as not moving. */
const STUCK_SPEED = 0.2;

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

  /** Continues the canonical tick sequence after a host rebuild. */
  resumeAtTick(tick: number): void {
    this.tick = Math.max(0, Math.floor(tick));
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
      // Addendum A4. Terrain states which body kinds it stops. A mask without
      // the avatar layer lets an avatar walk through the shape.
      const blocking = resolveTerrainBlocking(definition.blocks, this.canvas.terrainDefaults);
      this.attachCollider(record, {
        id: definition.id,
        role,
        shape: definition.shape,
        restitution: definition.restitution,
        friction: definition.friction,
        tags: definition.tags,
        collisionMask: role === "worldStatic" ? terrainMask(blocking) : undefined,
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

  private shapeDesc(shape: ShapeDefinition, scale = 1): RAPIER.ColliderDesc {
    switch (shape.type) {
      case "circle":
        return RAPIER.ColliderDesc.ball(shape.radius * scale);
      case "rect":
        return RAPIER.ColliderDesc.cuboid(
          (shape.width * scale) / 2,
          (shape.height * scale) / 2,
        );
      case "capsule":
        return RAPIER.ColliderDesc.capsule(
          shape.halfHeight * scale,
          shape.radius * scale,
        );
      case "polygon": {
        const points = new Float32Array(shape.vertices.length * 2);
        shape.vertices.forEach((vertex, i) => {
          points[i * 2] = vertex.x * scale;
          points[i * 2 + 1] = vertex.y * scale;
        });
        return (
          RAPIER.ColliderDesc.convexHull(points) ??
          RAPIER.ColliderDesc.ball(0.5)
        );
      }
    }
  }

  private attachCollider(record: BodyRecord, definition: ColliderDefinition): void {
    const scale = record.entity.kind === "item" ? record.entity.transform.scale ?? 1 : 1;
    const desc = this.shapeDesc(definition.shape, scale);
    const membership = definition.membership ?? roleMembership[definition.role];
    const filter = definition.collisionMask ?? roleDefaultMask[definition.role];
    const sensor = definition.sensor ?? isSensorRole(definition.role);

    desc
      .setSensor(sensor)
      .setCollisionGroups(collisionGroups(membership, filter))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (definition.offset) {
      desc.setTranslation(definition.offset.x * scale, definition.offset.y * scale);
    }
    if (definition.rotation !== undefined) desc.setRotation(definition.rotation);
    if (definition.restitution !== undefined) desc.setRestitution(definition.restitution);
    if (definition.friction !== undefined) desc.setFriction(definition.friction);
    if (definition.density !== undefined) desc.setDensity(definition.density);

    const collider = this.world.createCollider(desc, record.body);
    if (definition.enabled === false) collider.setEnabled(false);
    // Addendum A4. A shape query for this body uses the groups of its solid
    // collider, so the query ignores terrain the body passes through.
    if (definition.role === "avatarBody" || definition.role === "itemSolid") {
      record.queryGroups = collisionGroups(membership, filter);
    }
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
        definitionVersion: instance.definitionVersion,
        zIndex: definition.visual.zIndex ?? 0,
        size: definition.visual.size,
      },
      ownership: { ownerUserId: instance.ownerUserId },
      isolated: instance.isolated === true,
      collisionsDisabled: instance.collisionsDisabled === true,
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
        stateVersion: instance.behaviorStateVersion ?? 1,
        persistent: definition.persistence.behaviorState,
      };
    }

    this.registry.add(entity);
    const record: BodyRecord = { entity, body, colliders: new Map(), regions: new Set() };
    this.bodies.set(entity.id, record);
    for (const collider of definition.colliders) this.attachCollider(record, collider);
    if (instance.collisionsDisabled) this.setItemCollisionsEnabled(entity.id, false);
    if (instance.isolated) this.setItemIsolation(entity.id, true);
    return entity;
  }

  addAvatar(spawn: AvatarSpawn): Entity {
    const controller = resolveAvatarController(this.canvas.avatarController);
    const radius = spawn.radius ?? controller.radius;
    const entity: Entity = {
      id: spawn.entityId,
      kind: "avatar",
      transform: { x: spawn.position.x, y: spawn.position.y, rotation: 0 },
      avatar: {
        userId: spawn.userId,
        clientId: spawn.clientId,
        radius,
        maxSpeed: spawn.maxSpeed ?? controller.maxSpeed,
        acceleration: spawn.acceleration ?? controller.acceleration,
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

  /** Removes an owned item from every simulation subsystem while retaining its pose. */
  setItemIsolation(entityId: EntityId, isolated: boolean): boolean {
    const record = this.bodies.get(entityId);
    if (!record || record.entity.kind !== "item") return false;
    if (record.entity.isolated === isolated && record.body.isEnabled() === !isolated) {
      return true;
    }
    record.entity.isolated = isolated;
    record.body.setEnabled(!isolated);
    if (isolated) this.endContacts(entityId);
    return true;
  }

  /** Globally enables or disables an item's authored solid and sensor colliders. */
  setItemCollisionsEnabled(entityId: EntityId, enabled: boolean): boolean {
    const record = this.bodies.get(entityId);
    if (!record || record.entity.kind !== "item") return false;
    record.entity.collisionsDisabled = !enabled;
    for (const collider of record.colliders.values()) collider.setEnabled(enabled);
    if (!enabled) this.endContacts(entityId);
    return true;
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

    this.stepRespawns();

    for (const record of this.bodies.values()) {
      if (record.entity.respawning || record.entity.isolated) continue;
      this.applyEnvironment(record);
      this.driveAvatar(record, dt);
    }

    this.world.step(this.events);
    this.readTransforms();
    this.collectCollisionEvents();
    this.collectRegionEvents();
    this.collectDwellEvents();
    this.stepElevations(dt);
    // Spec 14.3. The quarantine runs first. A body far outside the canvas is
    // an invalid value, and a wrapped edge would otherwise bring it back and
    // hide the fault.
    this.quarantineInvalid();
    this.applyEdgePolicies();
    this.freeStuckBodies();

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
      // Addendum A4. The controller applies no group filter of its own, so the
      // groups of the avatar body are given here. Terrain that does not accept
      // the avatar layer then lets the avatar walk through.
      record.queryGroups,
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
      for (const [id, region] of
        record.entity.avatar?.disabled || record.entity.isolated ? [] : emitting) {
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
      if (
        record.entity.avatar?.disabled ||
        record.entity.respawning ||
        record.entity.isolated
      ) continue;
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
      if (record.entity.avatar?.disabled || record.entity.isolated) continue;
      if (record.entity.respawning) continue;
      const transform = record.entity.transform;
      const velocity = record.body.linvel();
      const radius = record.entity.avatar?.radius ?? 0;
      const resolution = resolveEdges(this.canvas, transform, velocity, radius);
      if (resolution.crossings.length === 0) continue;
      // Addendum A3. A respawn waits before the body comes back, so the loss of
      // the body reads as a loss rather than as a jump to the middle.
      if (resolution.respawn) {
        this.beginRespawn(record, resolution.spawnPointId);
        continue;
      }
      if (resolution.position) {
        const wrapped = resolution.crossings.find((crossing) => crossing.policy === "wrap");
        const target = wrapped
          ? this.clearOfGeometry(record, resolution.position, inwardOf(wrapped.edge))
          : resolution.position;
        record.body.setTranslation(target, true);
        transform.x = target.x;
        transform.y = target.y;
        // Addendum A2. The move is a jump, not motion. The renderer must snap.
        this.markTeleport(record);
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
    const radius = this.probeRadius(record);
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
        record.queryGroups,
        undefined,
        record.body,
        (collider) => !collider.isSensor(),
      );
      if (!hit) return probe;
      probe = { x: probe.x + inward.x * step, y: probe.y + inward.y * step };
    }
    return position;
  }

  /**
   * A radius that covers the body. The probe must be at least as large as the
   * body, or a place that is free for the probe still overlaps the body.
   */
  private probeRadius(record: BodyRecord): number {
    let radius = record.entity.avatar?.radius ?? 0;
    for (const collider of record.colliders.values()) {
      const half = collider.halfExtents();
      if (half) {
        radius = Math.max(radius, Math.hypot(half.x, half.y));
        continue;
      }
      const ball = collider.radius();
      if (Number.isFinite(ball)) radius = Math.max(radius, ball);
    }
    return Math.max(radius, 0.75);
  }

  /**
   * Spec 20. A large impulse can push a body into terrain, where the solver
   * cannot separate it and the body sits still forever. A body whose centre is
   * inside fixed geometry, and which has not moved for `STUCK_TICKS`, is placed
   * on the nearest surface of that geometry.
   */
  private freeStuckBodies(): void {
    for (const record of this.bodies.values()) {
      if (record.entity.kind === "static") continue;
      if (record.entity.rigidBody?.mode !== "dynamic") continue;
      if (record.entity.quarantined || record.entity.respawning || record.entity.isolated) {
        continue;
      }

      const speed = Math.hypot(record.body.linvel().x, record.body.linvel().y);
      if (speed > STUCK_SPEED) {
        record.stuckTicks = 0;
        continue;
      }
      const inside = this.insideGeometry(record);
      if (!inside) {
        record.stuckTicks = 0;
        continue;
      }
      record.stuckTicks = (record.stuckTicks ?? 0) + 1;
      if (record.stuckTicks < STUCK_TICKS) continue;

      record.stuckTicks = 0;
      const escape = this.escapeFrom(record, inside);
      record.body.setTranslation(escape, true);
      record.body.setLinvel({ x: 0, y: 0 }, true);
      record.body.setAngvel(0, true);
      record.entity.transform.x = escape.x;
      record.entity.transform.y = escape.y;
      this.markTeleport(record);
      this.pendingEvents.push({
        type: "unstuck",
        tick: this.tick,
        self: record.entity.id,
        from: { x: inside.x, y: inside.y },
        to: { ...escape },
      });
    }
  }

  /** The body centre, when it lies inside a fixed collider. */
  private insideGeometry(record: BodyRecord): Vec2 | undefined {
    const centre = record.body.translation();
    const projection = this.world.projectPoint(
      centre,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS |
        RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC |
        RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      record.queryGroups,
    );
    if (!projection || !projection.isInside) return undefined;
    return { x: centre.x, y: centre.y };
  }

  /**
   * The nearest free point outside the geometry. The body travels against the
   * local gravity, which is the direction a player expects, and it stops at the
   * first place where its shape no longer overlaps fixed geometry.
   */
  private escapeFrom(record: BodyRecord, centre: Vec2): Vec2 {
    this.environment.sample(centre, this.sample);
    const gravity = this.sample.gravityXY;
    const length = Math.hypot(gravity.x, gravity.y);
    const direction =
      length > 1e-6 ? { x: -gravity.x / length, y: -gravity.y / length } : { x: 0, y: -1 };
    return this.clearOfGeometry(record, centre, direction);
  }

  /** Spec 14.3 and 20. A NaN entity is quarantined rather than crashing the room. */
  private quarantineInvalid(): void {
    const { width, height } = this.canvas.size;
    // Spec 14.3. A body this far outside the canvas can no longer return, so it
    // is treated as an invalid value rather than as a body in flight.
    const margin = Math.max(width, height);
    for (const record of this.bodies.values()) {
      if (record.entity.isolated) continue;
      const transform = record.entity.transform;
      const finite =
        Number.isFinite(transform.x) &&
        Number.isFinite(transform.y) &&
        Number.isFinite(transform.rotation);
      const inRange =
        finite &&
        transform.x > -margin &&
        transform.x < width + margin &&
        transform.y > -margin &&
        transform.y < height + margin;
      if (inRange) continue;
      record.entity.quarantined = true;
      // Addendum A3. The body returns after the respawn delay, on the same path
      // as a body that crossed a respawn edge.
      if (this.respawnPolicy.applyToQuarantine) {
        this.beginRespawn(record);
        continue;
      }
      const spawn = this.spawnPosition();
      record.body.setTranslation(spawn, true);
      record.body.setLinvel({ x: 0, y: 0 }, true);
      record.body.setAngvel(0, true);
      transform.x = spawn.x;
      transform.y = spawn.y;
      transform.rotation = 0;
      this.markTeleport(record);
    }
  }

  // ---------- respawn (addendum A3) ----------

  /** The canvas policy, or the library default when the canvas states none. */
  private get respawnPolicy(): RespawnPolicy {
    return this.canvas.respawn ?? defaultRespawnPolicy;
  }

  private spawnPosition(spawnPointId?: string): Vec2 {
    const id = spawnPointId ?? this.respawnPolicy.spawnPointId;
    const named = id
      ? this.canvas.spawnPoints.find((point) => point.id === id)
      : undefined;
    const point = named ?? this.canvas.spawnPoints[0];
    return point
      ? { ...point.position }
      : { x: this.canvas.size.width / 2, y: this.canvas.size.height / 2 };
  }

  /**
   * Addendum A3. Takes the body out of the scene for the respawn delay. The
   * body is parked on its spawn point, but it is hidden, it holds no active
   * collider, and no force acts on it. A NaN position cannot stay in the world,
   * so the park happens now and only the return is delayed.
   */
  private beginRespawn(record: BodyRecord, spawnPointId?: string): void {
    if (record.entity.respawning) return;
    const spawn = this.spawnPosition(spawnPointId);
    const policy = this.respawnPolicy;

    record.body.setTranslation(spawn, true);
    record.body.setLinvel({ x: 0, y: 0 }, true);
    record.body.setAngvel(0, true);
    record.body.setRotation(0, true);
    record.entity.transform.x = spawn.x;
    record.entity.transform.y = spawn.y;
    record.entity.transform.rotation = 0;
    if (record.entity.rigidBody) {
      record.entity.rigidBody.velocity = { x: 0, y: 0 };
      record.entity.rigidBody.angularVelocity = 0;
    }
    record.stuckTicks = 0;
    record.regions.clear();

    const disabled: string[] = [];
    for (const [id, collider] of record.colliders) {
      if (!collider.isEnabled()) continue;
      collider.setEnabled(false);
      disabled.push(id);
    }
    record.respawnDisabled = disabled;
    record.entity.respawning = true;
    record.respawnTicks = Math.max(
      0,
      Math.round(Math.max(0, policy.delaySeconds) * this.tickRate),
    );
    this.markTeleport(record);
    this.pendingEvents.push({
      type: "respawn.start",
      tick: this.tick,
      self: record.entity.id,
      delaySeconds: Math.max(0, policy.delaySeconds),
    });
    if (record.respawnTicks === 0) this.completeRespawn(record);
  }

  private stepRespawns(): void {
    for (const record of this.bodies.values()) {
      if (!record.entity.respawning) continue;
      record.respawnTicks = (record.respawnTicks ?? 0) - 1;
      if (record.respawnTicks > 0) continue;
      this.completeRespawn(record);
    }
  }

  private completeRespawn(record: BodyRecord): void {
    for (const id of record.respawnDisabled ?? []) {
      record.colliders.get(id)?.setEnabled(record.entity.collisionsDisabled !== true);
    }
    record.respawnDisabled = undefined;
    record.respawnTicks = undefined;
    record.entity.respawning = false;
    record.entity.quarantined = false;
    this.markTeleport(record);
    this.pendingEvents.push({
      type: "respawn.end",
      tick: this.tick,
      self: record.entity.id,
      position: { ...record.entity.transform },
    });
  }

  /**
   * Addendum A2. Records a discontinuous move. A renderer that sees a new epoch
   * snaps the sprite instead of sliding it across the canvas.
   */
  private markTeleport(record: BodyRecord): void {
    record.entity.teleportEpoch = ((record.entity.teleportEpoch ?? 0) + 1) % 0xffff;
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
    const record = this.bodies.get(id);
    record?.colliders
      .get(colliderId)
      ?.setEnabled(enabled && record.entity.collisionsDisabled !== true);
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
    this.markTeleport(record);
  }

  setSpriteVariant(id: EntityId, variant: string): void {
    const render = this.registry.get(id)?.render;
    if (render) render.variant = variant;
  }

  startAnimation(id: EntityId, animation: string): void {
    const render = this.registry.get(id)?.render;
    if (render) {
      render.animation = animation;
      render.animationEpoch = (render.animationEpoch ?? 0) + 1;
    }
  }

  setSpriteTint(id: EntityId, tint: number | undefined): void {
    const render = this.registry.get(id)?.render;
    if (render) render.tint = tint;
  }

  /** Atomically applies uniform visual/physics scale to an authored item. */
  setScale(id: EntityId, scale: number): void {
    const record = this.bodies.get(id);
    if (!record || record.entity.kind !== "item" || !Number.isFinite(scale) || scale <= 0) {
      return;
    }
    if (Math.abs((record.entity.transform.scale ?? 1) - scale) < 0.0001) return;
    const definition = this.definitions.get(record.entity.render?.definitionId ?? "");
    if (!definition) return;

    this.endContacts(id);
    for (const collider of record.colliders.values()) {
      this.colliderOwner.delete(collider.handle);
      this.world.removeCollider(collider, true);
    }
    record.colliders.clear();
    record.entity.colliders = [];
    record.entity.transform.scale = scale;
    for (const collider of definition.colliders) this.attachCollider(record, collider);
    if (record.entity.collisionsDisabled) {
      for (const collider of record.colliders.values()) collider.setEnabled(false);
    }
    record.body.wakeUp();
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
