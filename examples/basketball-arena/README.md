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

## Configuration boundary

The authoritative canvas and the system ball's resolved configuration contain
the reusable game recipe:

- court size, solid edges, player movement, spawn points, and system items;
- direct avatar dragging, quick-flick thresholds, and canvas-owned slide
  deceleration;
- mirrored decorative hoops plus matching backboard and rim collision;
- circular basket sensors and team-award tags;
- localized net damping around each hoop;
- kick, pinch, spin, cooldown, and impulse tuning;
- two points per basket, first to six, 1.25-second possession resets, a
  three-second game-over display, and center-ball reset placement.

The consumer behavior is deliberately small. It translates configured avatar
contacts into impulses, configured region tags into score changes, and timer
events into the configured possession or game reset. It does not contain court
coordinates, team tags, score values, win thresholds, or delays.

The scoreboard is product-owned DOM using replicated immutable behavior state.
Its generated frame remains ordinary UI art; Canvas does not learn about team
names or sports scoreboards.

The fullscreen button uses `CanvasRuntime.toggleFullscreen()` with the product
shell supplied as `fullscreenElement`. Consumers own the button and layout;
Canvas owns the small enter/exit/state capability. `avatarDrag` remains
host-resolved input: while held, the avatar center follows the absolute pointer
position in one tick without a speed cap, with fixed geometry swept across the
entire move. Release-flick thresholds live in runtime input configuration, while
`avatarController.flickDeceleration` lives in the authoritative canvas.
