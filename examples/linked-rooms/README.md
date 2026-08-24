# Linked rooms reference integration

This independently runnable consumer demonstrates collision-triggered travel
between two Canvas rooms. The destination runtime becomes ready before the
origin closes. Both physical doors are exact reverse links, and the Back button
uses the same validated return route as an escape hatch.

```bash
pnpm example:rooms:server
pnpm example:rooms
```

Open `http://localhost:5176/?autojoin=1&user=traveler`. The Vite server binds to
the LAN interface and proxies `/v1` WebSocket traffic to the reference service
on port 8084. Give simultaneous tabs or devices different `user` values. A
second connection with the same participant identity intentionally replaces
the first one instead of creating a duplicate avatar.
