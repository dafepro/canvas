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
| `examples/soccer-lounge` | Independently runnable consumer integration with custom soccer behavior, field data/art, and scoreboard UI. |
| `examples/item-playground` | Compact item-management integration covering spawn, drag, rotate, scale, configuration, deletion, effects, ownership, portals, and sensor-only force fields. |
| `examples/linked-rooms` | Reversible collision-triggered travel that stages and swaps between independently hosted Canvas rooms. |
| `docker/`, `docker-compose.yml` | The local stack: service, network emulator, demo. |

## Consume the JavaScript packages

The three JavaScript packages expose built ESM and declaration files; consumers
do not compile Canvas TypeScript source. Each package builds automatically when
packed:

```bash
pnpm --filter @canvas-physics/core pack --pack-destination ./artifacts
pnpm --filter @canvas-physics/protocol pack --pack-destination ./artifacts
pnpm --filter @canvas-physics/client pack --pack-destination ./artifacts
```

Install all three archives in an external application until registry releases
are configured. `@canvas-physics/client/worker` resolves to the packaged default
simulation worker. Application-defined worker behavior registration is tracked
by the build-time worker API in `docs/EXTENSION_CONTRACT.md`.

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

## Run a reference integration

Reference integrations consume only public package exports and own their domain
content. The soccer lounge runs its own frontend and reference-service data:

```bash
pnpm example:soccer:server # terminal 1; service on :8082
pnpm example:soccer        # terminal 2; app on :5174
```

Open <http://localhost:5174>. See `docs/EXAMPLE_INTEGRATIONS.md` for the
examples contract and the generic gaps the soccer integration is designed to
expose.

For the compact item-management playground:

```bash
pnpm example:items:server # terminal 1; service on :8083
pnpm example:items        # terminal 2; app on :5175
```

Open <http://localhost:5175>. Add `?autojoin=1&user=alex` for a named client;
open a second tab with a different user to demonstrate owner-only edits. The
development server proxies realtime traffic to `:8083`, so LAN devices only
need access to the app's `:5175` address.

For reversible travel between two independent rooms:

```bash
pnpm example:rooms:server # terminal 1; service on :8084
pnpm example:rooms        # terminal 2; app on :5176
```

Open <http://localhost:5176/?autojoin=1&user=traveler>. Walk into the glowing
door or use Back after traveling. See `docs/LINKED_ROOM_TRAVEL.md` for the
authorization, staging, rollback, and reverse-route contract.

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
store.PutItemDefinition(roomsdk.ItemDefinitionRecord{
    DefinitionID:  "rocket",
    Version:       1,
    Complexity:    roomsdk.ItemComplexityComplex,
    ConfigSchema:  rocketConfigSchemaJSON,
    DefinitionRaw: rocketDefinitionJSON,
})

server, err := roomsdk.New(roomsdk.Config{
    Store: store,
    Auth:  myAuthenticator, // any type with an Authenticate method
    RoomTemplates: roomsdk.StaticRoomTemplates{
        "team-42-lounge": {
            CanvasID: "rocket-canvas", CanvasVersion: 1,
        },
    },
})
if err != nil {
    return err
}
mux.Handle("/", server.Handler())
```

`Store`, `Authenticator`, and `RoomTemplateResolver` are the required host
ports. The resolver maps product room instances to exact reusable canvas
templates; a production integration can implement it against product data.
The store holds authoritative canvas, item-definition, schema, and snapshot
records.
The reference `canvasd` uses `FileStore` and writes restart-safe snapshots to
`CANVASD_DATA_DIR` (or `./data`); Docker Compose mounts that directory as the
named `canvasd-data` volume. Embedded services can use `FileStore` directly or
replace it with a database-backed implementation.

## Use the client library

```ts
import { productCanvasDefinitions } from "./canvas-content.js";

export const enterCanvasRoute = async () => {
  const { CanvasRuntime } = await import("@canvas-physics/client/runtime");
  const runtime = new CanvasRuntime({
    roomId: "team-42-lounge",
    serverUrl: "http://localhost:8081",
    credentialProvider: async () => {
      const response = await fetch("/api/canvas-ticket", { method: "POST" });
      if (!response.ok) throw new Error("could not obtain a canvas ticket");
      return response.text();
    },
    mount: document.querySelector("#stage")!,
    definitions: productCanvasDefinitions,
  });
  const subscriptions = new AbortController();
  runtime.subscribeStartup((snapshot) => {
    renderProductLoadingState(snapshot);
  }, { signal: subscriptions.signal });
  await runtime.start();
  return {
    runtime,
    leave: async () => {
      subscriptions.abort();
      await runtime.stopGracefully();
    },
  };
};
```

`start()` is the browser reveal gate: it waits for
required assets, room access, JOIN, simulation, complete canonical state, and
the first renderer update. `subscribeStartup()` reports each of those waits as
a frozen semantic snapshot, including per-source asset settlement and typed terminal failure.
`RoomSession.whenPresented()` remains the lower-level headless gate for a
complete authoritative entity set.

The `@canvas-physics/client/runtime` subpath is deliberately loaded with
`import()`. Product routes that never enter a canvas do not download Pixi,
Rapier, the runtime, or its simulation worker. Create an application-owned
worker only inside the same route/join boundary when registering custom
behaviors.

The credential provider runs again for every reconnect. The rooms SDK derives
identity from that ticket and returns the authenticated user in JOIN_ACCEPTED;
the browser never declares its own identity in JOIN. See
`docs/HOST_INTEGRATION.md` for the ticket and origin contract.

Applications can subscribe to authenticated presence, complete canonical
entity and behavior state, and effects through `CanvasRuntime`. Snapshot streams
replay their newest frozen value to late subscribers; see
`docs/LIBRARY_CONTRACT.md` for the ownership and observation contract.
Applications can also register ordered, local-only pointer interaction
strategies without attaching competing listeners to the Canvas surface; see
`docs/POINTER_INTERACTIONS.md`.

Every item mutation returns an acknowledged receipt. Consumers can display the
matching accepted or typed-rejected outcome without inferring success from an
unrelated scene update; see `docs/ITEM_MUTATIONS.md`.

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
- `docs/CI_RELEASE_GATE.md` — required Windows/Linux checks and what a passing
  release candidate guarantees independent consumers.
- `docs/NETWORK_FAULT_TESTING.md` — deterministic loss, latency, jitter, and
  reordering test support plus the verified fault matrix.
- `docs/ITEM_MUTATIONS.md` — receipts, edit leases, conflicts, retries, and
  canonical presentation reconciliation.
- `docs/spec.txt` — the plain text of the specification, for searching.
