# External consumer conformance kits

Conformance kits are framework-neutral checks that a consumer runs in its own
repository against its own adapters and extensions. They complement Canvas's
internal tests: a green Canvas build cannot prove that a product behavior,
authenticator, store, transport, or worker bundle honors the public contract.

## Delivery status

- [x] Behavior metadata, JSON data, deterministic initialization/replay,
  sleep normalization, and durable migration coverage.
- [x] Host `Authenticator` implementations.
- [x] Host `Store` implementations.
- [x] Custom `RoomTransport` implementations.
- [x] Application-owned simulation worker bundles.

Every kit above is now runnable from a clean external package install.

## Behavior kit

Import test utilities from the dedicated subpath so production code does not
pull in the harness:

```ts
import {
  runBehaviorConformance,
  type BehaviorConformanceScenario,
} from "@canvas-physics/core/testing";

const scenarios: BehaviorConformanceScenario<MyConfig, MyState>[] = [
  {
    name: "representative interaction",
    exercise: (harness) => {
      harness.send(myEvent).flush().advance(30);
    },
  },
];

const report = runBehaviorConformance(MyBehavior, config, { scenarios });
expect(report.issues).toEqual([]);
```

The immutable report is independent of Vitest or Jest. It validates portable
behavior identifiers, positive state versions, unique known subscriptions,
JSON config and state, deterministic initialization, deterministic sleep
normalization, and two identical executions of every consumer-owned scenario.
For durable state above version 1, it requires a migration chain and one input
case for every prior state version, then checks each migration for successful,
serializable, deterministic output.

The scenario comparison includes behavior state, applied commands, effects,
tick, and the complete fake-body state. Scenarios are mandatory because generic
metadata inspection cannot discover which domain events matter to a consumer.
The soccer lounge runs its kick/score/reset path through this public kit.

## Authenticator kit

Go hosts import `github.com/dafepro/canvas/server/pkg/roomsdktest` and call
`RunAuthenticatorConformance` from their own `_test.go` file. Each case supplies
an HTTP request and either the exact expected stable `roomsdk.Identity` or an
unauthorized expectation. The suite requires at least one success and one
rejection, requires successful identities to contain both names, and requires a
rejection to return `roomsdk.ErrUnauthorized` with no partial identity.

```go
func TestProductAuthenticator(t *testing.T) {
    roomsdktest.RunAuthenticatorConformance(t, productAuth, []roomsdktest.AuthenticatorCase{
        {Name: "valid ticket", Request: valid, WantIdentity: expected},
        {Name: "expired ticket", Request: expired, Unauthorized: true},
    })
}
```

The host owns ticket issuance, expiration, origin policy, and replay semantics;
the kit owns only the identity/error boundary visible to Canvas.

## Store kit

`RunStoreConformance` accepts a `StoreConformanceFixture` whose `NewStore`
function returns a fresh adapter preloaded with one canvas and item definition.
The suite verifies semantic JSON equality for catalog records, zero records plus
`roomsdk.ErrNotFound` for misses, snapshot round trips, room isolation, rejection
of stale checkpoint revisions, and highest-revision wins under concurrent saves.

Production adapters should also supply `ReopenStore`, which constructs a fresh
adapter over the same backing data. The suite then proves that the latest
checkpoint survives loss of process-local state. The volatile `MemoryStore`
intentionally omits this callback; the reference `FileStore` exercises it.

```go
func TestProductStore(t *testing.T) {
    roomsdktest.RunStoreConformance(t, roomsdktest.StoreConformanceFixture{
        NewStore: loadSeededTestDatabase,
        ReopenStore: reopenTestDatabase,
        Canvas: canvasFixture,
        ItemDefinition: definitionFixture,
        MissingCanvasID: "missing-canvas",
        MissingItemDefinitionID: "missing-definition",
        MissingRoomID: "missing-room",
    })
}
```

## Room transport kit

Import `runRoomTransportConformance` from
`@canvas-physics/client/testing`. The fixture creates the consumer transport
and exposes its test peer: one method observes outbound envelopes, one delivers
inbound envelopes, and one interrupts the live connection. This lets a local
WebSocket server, WebRTC remote endpoint, or other adapter-specific harness
drive the same public checks without Canvas knowing its internals.

```ts
const report = await runRoomTransportConformance({
  create: () => openProductTransportFixture(),
});
expect(report.issues).toEqual([]);
```

The suite verifies zeroed cumulative counters, the `idle` → `connecting` →
`open` lifecycle, ordered reliable delivery, uncongested realtime delivery,
inbound delivery, listener unsubscription, reconnect recovery in both
directions, cumulative encoded-byte/message counters, and terminal caller
close. The immutable report is independent of Vitest or Jest. The test peer is
responsible for running against the real adapter boundary rather than calling
private transport methods directly.

## Simulation worker bundle kit

`runSimulationWorkerConformance` also comes from
`@canvas-physics/client/testing`. Its fixture wraps the application-owned worker
entry with only `postMessage`, `onMessage`, and `terminate`; consumers should
construct that wrapper around the actual bundled Worker in a browser-capable
test. The fixture supplies its ordinary initialization request and at least one
representative application-behavior scenario.

```ts
const report = await runSimulationWorkerConformance({
  create: () => wrapWorker(new Worker(workerUrl, { type: "module" })),
  init: productSimulationInit,
  scenarios: [{
    name: "product behavior advances",
    exercise: async (worker) => {
      worker.send(addProductItem);
      await worker.waitFor(hasAdvancedProductState, "behavior did not advance");
    },
  }],
});
expect(report.issues).toEqual([]);
```

The suite verifies worker readiness, data-only request/response exchange,
snapshot metadata, representative custom behavior, listener cleanup, and
quiet termination. Worker `error` responses become report issues. The soccer
example's production build remains the packed-artifact proof that Vite can
discover and emit the application-owned worker entry.
