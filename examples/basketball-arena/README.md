# Basketball arena reference integration

This independently runnable consumer demonstrates a configuration-first,
multiplayer basketball game. Canvas owns the room, synchronization, host
simulation, physics, collision, rendering, and durable behavior state. The
example owns its sport rules, court data, generated artwork, and scoreboard UI.

```bash
pnpm example:basketball:server
pnpm example:basketball
```

Open `http://localhost:5177/?autojoin=1&user=baller-one`. Both servers bind to
the LAN interface; use a distinct `user` value for each simultaneous device.
The room service stores ordinary local state under `.data/v0.4.0`; set
`CANVAS_EXAMPLE_DATA_DIR` to select a durability or migration fixture
explicitly. Release scoping preserves older snapshots without allowing an
incompatible snapshot to prevent the current arena opening.

## Configuration boundary

The authoritative canvas and the system ball's resolved configuration contain
the reusable game recipe:

- court size, solid edges, player movement, spawn points, and system items;
- direct avatar dragging, quick-flick thresholds, canvas-owned slide
  deceleration, fixed visual facing, and bounded contact speed for uncapped drag;
- radius-aware edge clamping plus full-path collision sliding when the held
  pointer leaves the court;
- definition-level mirrored hoop art plus matching backboard and rim collision;
- circular basket sensors and team-award tags;
- localized net damping around each hoop;
- kick, pinch, spin, cooldown, and impulse tuning;
- two points per basket, first to six, 1.25-second possession resets, a
  three-second game-over display, and center-ball reset placement.

The consumer behavior is deliberately small. It translates configured avatar
contacts into impulses, configured region tags into score changes, and timer
events into the configured possession or game reset. It does not contain court
coordinates, team tags, score values, win thresholds, or delays.

Each generated scoreboard shell is an immutable system item above its basket.
Product-owned DOM projects replicated immutable behavior state into the item at
60 Hz through Canvas's renderer-safe overlay seam. Canvas does not learn about
team names or score rules. The overlay uses one centered number aperture for
both teams, scales two- and three-character text, and displays scores above 99
as `99+`; the authoritative score is never truncated. The speed-scaled avatar
fire trail is likewise product configuration through `scene.motionTrails`, not
basketball engine code. This example keeps its maximum particles small and
semi-transparent so only genuinely fast movement produces a noticeable trail.

The fullscreen button uses `CanvasRuntime.toggleFullscreen()` with the product
shell supplied as `fullscreenElement`. Consumers own the button and layout;
Canvas owns the small enter/exit/state capability. `avatarDrag` remains
host-resolved input: while held, the avatar center follows the absolute pointer
position in one tick without a speed cap, with fixed geometry swept across the
entire move. Release-flick thresholds live in runtime input configuration, while
`avatarController.flickDeceleration` lives in the authoritative canvas.
`avatarController.facing: "fixed"` keeps this upright character art from
turning. `avatarController.directInteractionMaxSpeed` bounds only the contact
velocity seen by behaviors; it does not cap how far the held avatar follows the
pointer in a tick.

An active direct grab continues listening on the canvas's owning window, so a
pointer outside the court still moves the avatar along the nearest reachable
edge. The fullscreen product shell centers the largest court that fits the
dynamic viewport; the renderer observes the stage size and refits after mobile
orientation changes.

Basket frame and rim colliders set `blocks: { avatars: false, items: true }`.
The mirrored ball geometry remains authoritative and symmetric, while players
can pass beneath the perspective hoop art instead of catching on an invisible
backboard. Effective direct-drag velocity is also published to presentation,
so speed-scaled trails work for pointer motion even though exact placement does
not use the kinematic body's linear velocity.

Three client-side control trials use the same authoritative room physics:

- default: direct pointer placement with release flick;
- `?flick=0`: direct pointer placement that stops on release;
- `?control=thumbstick`: continuous velocity control from an empty-court drag.

The active profile is shown above the court. The reference integration uses a
120 px/s flick threshold so a quick release produces an obvious coast; the stop
profile has no release impulse at all.
