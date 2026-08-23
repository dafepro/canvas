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
- [ ] Custom `RoomTransport` implementations.
- [ ] Application-owned simulation worker bundles.

The parent P2 backlog item remains open until every kit above is runnable from
a clean external package install.

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
