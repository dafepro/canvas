# Canvas Physics

A reusable library for a physics-based realtime multiplayer 2D canvas, plus a
plug-and-play server SDK. The design follows
`docs/realtime_multiplayer_2d_canvas_spec.docx`.

Physics never runs on the server. One elected browser client is the simulation
host. The server grants a single host lease, relays realtime packets, enforces
item ownership, and stores canonical checkpoints.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/core` | The reusable library: data model, entity registry, behavior runtime, environment fields, tuning rules, validation, test harness. No browser dependency. |
| `packages/protocol` | `room.proto`, the contract of record, plus the generated TypeScript bindings and the envelope codec. |
| `packages/client` | Browser runtime: Rapier simulation worker, PixiJS renderer, input, transports, interpolation, reconciliation. |
| `server/pkg/roomsdk` | The Go server SDK. Drop it into an existing Go service. |
| `server/cmd/canvasd` | Reference binary that wires the SDK to an HTTP listener. |
| `apps/demo` | Browser demo of the rocket canvas from spec section 18. |
| `docker/`, `docker-compose.yml` | The local stack: service, network emulator, demo. |

## Run the local stack

```bash
make install      # install the JavaScript and Go dependencies
make up           # build and start canvasd, Toxiproxy, and the demo
```

Then open <http://localhost:5173>. Open a second browser window with a
different `?user=` value to see two clients share one canvas.

| Address | Purpose |
| --- | --- |
| <http://localhost:5173> | The demo page |
| <http://localhost:8081> | The service through Toxiproxy, which the demo uses |
| <http://localhost:8080> | The service directly, with no impairment |
| <http://localhost:8474> | The Toxiproxy control API |

Add `?debug=1` to the demo URL to draw collider outlines.

Stop the stack with `make down`.

## Emulate a bad network

`scripts/net.sh` drives Toxiproxy, so impairment needs no code change.

```bash
scripts/net.sh preset 3g      # 100 ms latency, 30 ms jitter, 96 KB/s
scripts/net.sh preset bad     # 200 ms latency, 80 ms jitter, 32 KB/s
scripts/net.sh preset lossy   # 60 ms latency plus 5 percent dropped traffic
scripts/net.sh latency 150 40 # set latency and jitter directly
scripts/net.sh drop           # cut every open connection
scripts/net.sh restore        # allow connections again
scripts/net.sh clear          # remove every impairment
scripts/net.sh status         # show what is active
```

Use `drop` then `restore` to test host migration and reconnection. When you cut
the host's connection, the server revokes the lease, increments the host epoch,
and grants the lease to another client.

## Develop without Docker

```bash
# Terminal 1: the coordination service
cd server && go run ./cmd/canvasd -canvases ./canvases

# Terminal 2: the demo with hot reload
make demo
```

The demo reads `VITE_SERVER_URL`. It defaults to port 8080 on the current host.

## Test

```bash
make test        # every test
make test-ts     # TypeScript: behavior harness plus real Rapier physics
make test-go     # Go: host lease, ownership, sleep and wake, with -race
```

`packages/client/test/two-client-relay.test.ts` builds `canvasd`, starts it on a
free port, and joins two headless clients over a real WebSocket. It needs the Go
toolchain. The test skips itself when `go` is absent.

## Use the server SDK

```go
store := roomsdk.NewMemoryStore()
store.PutCanvas(roomsdk.CanvasRecord{
    CanvasID:      "rocket-canvas",
    Version:       1,
    DefinitionRaw: canvasJSON,
})

server, err := roomsdk.New(roomsdk.Config{
    Store: store,
    Auth:  myAuthenticator, // any type with an Authenticate method
})
if err != nil {
    return err
}
mux.Handle("/", server.Handler())
```

`Store` and `Authenticator` are the only interfaces you must supply. Replace
`MemoryStore` with a database-backed type to persist a canvas between restarts.

## Use the client library

```ts
import { CanvasRuntime, rocketCanvasDefinitions } from "@canvas-physics/client";

const runtime = new CanvasRuntime({
  canvasId: "rocket-canvas",
  serverUrl: "http://localhost:8081",
  userId: "alice",
  displayName: "Alice",
  mount: document.querySelector("#stage")!,
  definitions: rocketCanvasDefinitions,
});
await runtime.start();
runtime.spawnItem("rocket", { x: 70, y: 61 });
```

## Add a behavior

A behavior consumes normalized events and returns commands. It never touches
the renderer, the transport, or persistence.

```ts
import type { ItemBehavior } from "@canvas-physics/core";

export const BouncerBehavior: ItemBehavior<{ boost: number }, { hits: number }> = {
  behaviorType: "bouncer",
  stateVersion: 1,
  subscribes: ["bounce"],
  initialState: () => ({ hits: 0 }),
  onEvent: (_ctx, config, state, event) => {
    if (event.type !== "bounce") return { state, commands: [] };
    return {
      state: { hits: state.hits + 1 },
      commands: [
        {
          type: "applyImpulse",
          impulse: { x: event.normal.x * config.boost, y: event.normal.y * config.boost },
        },
        { type: "emitEffect", effect: "bouncePop" },
      ],
    };
  },
};
```

Test it with no physics engine and no browser:

```ts
import { BehaviorTestHarness } from "@canvas-physics/core";

const harness = new BehaviorTestHarness(BouncerBehavior, { boost: 5 });
harness.send({ type: "bounce", other: party, normal: { x: 0, y: -1 }, relativeSpeed: 9 }).flush();
expect(harness.state.hits).toBe(1);
```

## Regenerate the protocol

`packages/protocol/proto/room.proto` is the contract of record. After editing it:

```bash
make generate
```

This writes the TypeScript bindings and the Go bindings from the same file.

## Documentation

- `docs/PHASES.md` — the state of each phase from spec section 23.
- `docs/ARCHITECTURE.md` — how the pieces fit together and why.
- `docs/spec.txt` — the plain text of the specification, for searching.
