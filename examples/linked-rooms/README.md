# Linked rooms reference integration

This independently runnable consumer demonstrates collision-triggered travel
among three Canvas rooms. The village's right door opens the moonlit cave; its
left open door leads to an original pixel-art adventure room. The destination
runtime becomes ready before the origin closes, and the departing avatar is
hidden and disabled while that destination stages. Every physical door is an
exact reverse link, and the Back button uses the same validated return route as
an escape hatch.

The pixel room includes matching authored collision around its furniture and a
dynamic ball using Canvas's built-in `kickable` behavior. Avatar contact adds a
configurable impulse (rather than merely transferring avatar momentum), so the
ball can ricochet around the room while remaining ordinary synchronized room
state. The room, open-door, and ball artwork are consumer-owned generated
assets loaded through the public asset manifest.

```bash
pnpm example:rooms:server
pnpm example:rooms
```

Open `http://localhost:5176/?autojoin=1&user=traveler`. The Vite server binds to
the LAN interface and proxies `/v1` WebSocket traffic to the reference service
on port 8084. Give simultaneous tabs or devices different `user` values. A
second connection with the same participant identity intentionally replaces
the first one instead of creating a duplicate avatar. The server stores
ordinary local state under `.data/v0.4.1`; set `CANVAS_EXAMPLE_DATA_DIR` to select a durability or
migration fixture explicitly. Release scoping preserves older snapshots
without letting an incompatible snapshot prevent the current example opening.

The active room is stored in the `room` URL parameter after a successful
transition. Refresh therefore rejoins the committed room, and unknown room IDs
fall back to the village. Arrival links use their named spawn points. The rooms
service intentionally scopes participant uniqueness per room; applications
that require one global account location enforce that policy when issuing
destination credentials.
