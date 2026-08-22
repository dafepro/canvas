# Addendum to the specification

This file records a requirement that arrived after the specification. Each
entry names the phase that owns the work and the reason for that phase.

## A1 — Disable an avatar

**Requirement.** An operator or a player must be able to disable an avatar. A
disabled avatar stays in the room and stays visible at its last position, but no
physics act on it.

**Behavior when an avatar is disabled.**

1. The avatar does not respond to input. Its velocity is zero.
2. No force, no gravity, and no drag act on it.
3. It does not collide with a body, and no body collides with it. A moving item
   passes through it.
4. It emits no contact event, no region event, and no dwell event. A behavior
   that counts avatars does not count it.
5. It keeps its identity, its transform, and its ownership. The renderer draws
   it at a reduced opacity.
6. It leaves the disabled state at the same position it entered it.

**Why the room needs it.** Three cases:

- A player who steps away leaves an avatar that blocks a launch pad or a
  workflow. A disabled avatar removes that effect without removing the player.
- A demonstration needs a still avatar in the scene.
- A moderator needs a way to stop one player from disturbing a room without
  ending that player's session.

**Owner: Phase 5, advanced interaction primitives.** Phase 5 owns the rules that
decide when a body takes part in contact and in a behavior trigger. The disabled
state is one more such rule, and rule 4 above changes the contact and dwell code
that Phase 5 built. The work is small and it removes a demo obstacle, so it runs
before the Phase 6 hardening work.

**State of the work.** Built. See `AvatarComponent.disabled`,
`RapierWorld.setAvatarDisabled`, the `disabled` field on `EntityState`, and the
`avatarDisabled` field on `PlayerInput`. The demo toggles it with the `P` key.

## A2 — A jump must not be drawn as motion

**Requirement.** When a policy moves a body from one place to another in one
tick, every client must draw the jump as a jump. The sprite must appear at the
new place. It must not slide there.

**Reason.** The render path of spec 10.4 holds two host states and blends
between them. A wrap across an edge puts the two states on opposite sides of the
canvas. The blend then draws the body travelling all the way back, which is the
opposite of what the policy did. The same fault applies to a respawn, to an
unstuck move, and to an owner who drags an item.

**Behavior.**

1. The host raises a per-entity counter on every discontinuous move. The counter
   is `teleportEpoch`. A wrap, a respawn, an unstuck move, and a teleport all
   raise it.
2. The counter travels on `EntityState`, so a delta carries it on the tick of
   the jump.
3. `InterpolationBuffer` draws the newer state as it is when the two states hold
   different counters.
4. `AvatarReconciler` drops its offset when the counter changes, because the
   move is not a prediction error.

**Owner: Phase 6, hardening.** Phase 6 owns the render and network path.

**State of the work.** Built. See `Entity.teleportEpoch`,
`RapierWorld.markTeleport`, and `InterpolationBuffer.blend`.

## A3 — A body that leaves the canvas returns after a delay

**Requirement.** A body that crosses a `respawn` edge must be out of the scene
for a set time before it returns. It must not appear in the middle of the canvas
on the same tick that it left.

**Reason.** An instant return reads as a fault, not as a rule. A player who
walks off the side sees the avatar at the centre with no signal that anything
happened. A short absence makes the rule legible.

**Behavior.**

1. `CanvasDefinition.respawn` states `delaySeconds`, an optional
   `spawnPointId`, and `applyToQuarantine`. The library default is 1.5 seconds
   and it applies to a quarantine.
2. The host parks the body on its spawn point, switches off every collider,
   zeroes its velocity, and marks it `respawning`. A position that holds a NaN
   cannot stay in the physics world, so the park happens at once and only the
   return is delayed.
3. While the body waits, it is not drawn, no force acts on it, it collides with
   nothing, and it emits no region or contact event.
4. At the end of the delay the colliders return, the body becomes visible, and
   the teleport counter of A2 rises.
5. The host emits `respawn.start` and `respawn.end`, so a behavior can reset its
   state.

**Owner: Phase 6, hardening.** The delay changes the edge code and the
quarantine code, which Phase 6 owns.

**State of the work.** Built. See `RespawnPolicy`, `RapierWorld.beginRespawn`,
and the `respawning` field on `EntityState`. The reference canvas states two
seconds on its left and right edges.

## A4 — Terrain states which body kinds it stops

**Requirement.** An avatar must pass through canvas terrain by default. Each
static collider must be able to state whether it stops an avatar, an item, both,
or neither.

**Reason.** A canvas is a stage, not a maze. An avatar that a hill can trap is a
support problem. An item still needs a floor and a slope, so the two body kinds
need different rules on the same shape.

**Behavior.**

1. `StaticColliderDefinition.blocks` holds `{ avatars?, items? }`.
2. `CanvasDefinition.terrainDefaults` holds the same shape and applies to every
   collider that states none.
3. The library default is `{ avatars: false, items: true }`.
4. The rule becomes the collision filter mask of the static collider. Rapier
   needs both sides of a pair to accept it, so a mask without the avatar layer
   is enough to let every avatar through.
5. The character controller, the stuck-body probe, and the wrap probe all use
   the collision groups of the moving body. Terrain that a body passes through
   therefore does not block it and does not trap it.

**Owner: Phase 5, advanced interaction primitives.** Phase 5 owns the collision
role and mask rules of spec 5.3.

**State of the work.** Built. See `TerrainBlocking`, `terrainMask`, and
`RapierWorld.buildStaticGeometry`. In the reference canvas the floor blocks an
avatar; the hill and the launch pad do not.
