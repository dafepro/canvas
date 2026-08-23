# Soccer lounge example

An independently runnable consumer of Canvas Physics. It owns its soccer
behavior, field definition, reference-service data, worker entry, field art,
and scoreboard UI. It imports no Canvas source or private module.

From the repository root, start the example-specific rooms service:

```bash
pnpm example:soccer:server
```

In another terminal, start the browser app:

```bash
pnpm example:soccer
```

Open <http://localhost:5174>. Add `?autojoin=1&user=alex` to join immediately,
or `?debug=1` to inspect the collision geometry. Add `?kickAnimation=0` (or
append `&kickAnimation=0` to other flags) to hide the deformation atlas while
testing the ball's physical rotation. The service listens on port 8082 and
stores local state under `examples/soccer-lounge/.data`.

The room template materializes one system-owned match ball exactly once when no
snapshot exists. Participants can kick it but cannot move, reconfigure, rotate,
or delete it through durable authoring commands.

Run its focused checks with:

```bash
pnpm --filter @canvas-physics/example-soccer-lounge test
pnpm --filter @canvas-physics/example-soccer-lounge build
```
