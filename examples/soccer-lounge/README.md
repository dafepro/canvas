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
stores local state under the coordinated release directory
`examples/soccer-lounge/.data/v0.4.1`. Future library versions use a new
directory instead of reinterpreting intentionally incompatible demo snapshots.
Set `CANVAS_EXAMPLE_DATA_DIR` when deliberately testing restart durability or a
data migration against a specific directory.

The example selects Canvas's relative `thumbstick` pointer mode and a faster
canvas-owned avatar controller. Touch or click anywhere on the field, then drag
in the direction of travel. Keyboard movement remains available. The alternate
`avatarDrag` mode remains part of the Canvas runtime for integrations whose
scale suits direct manipulation.

Both development processes listen on all network interfaces. To join from a
device on the same network, replace `localhost` with the development computer's
LAN address, for example `http://LAN-IP:5174/?autojoin=1&user=phone`.
The client automatically connects to port 8082 on the same host. A host firewall
must allow inbound TCP ports 5174 and 8082, and the network must allow devices to
communicate with one another.

On Windows, run the included setup script from an administrator PowerShell once:

```powershell
./examples/soccer-lounge/scripts/allow-windows-lan.ps1
```

It permits only TCP 5174 and 8082, only from the local subnet, on Private or
Public network profiles.

The room template materializes one system-owned match ball exactly once when no
snapshot exists. Participants can kick it but cannot move, reconfigure, rotate,
or delete it through durable authoring commands.

The example's ball behavior separates `kickStrength`, which turns player motion
into a kick, from `pinchStrength`, which amplifies a ball returning toward a
player. Repeated player-wall contacts can therefore build speed, while
`maxImpulse` and the canvas `softSpeedLimit` keep the effect bounded. These are
consumer-owned soccer settings; the Canvas engine needs no soccer-specific
physics path.

Run its focused checks with:

```bash
pnpm --filter @canvas-physics/example-soccer-lounge test
pnpm --filter @canvas-physics/example-soccer-lounge build
```
