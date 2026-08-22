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
