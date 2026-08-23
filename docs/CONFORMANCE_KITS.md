# External consumer conformance kits

Conformance kits are framework-neutral checks that a consumer runs in its own
repository against its own adapters and extensions. They complement Canvas's
internal tests: a green Canvas build cannot prove that a product behavior,
authenticator, store, transport, or worker bundle honors the public contract.

## Delivery status

- [x] Behavior metadata, JSON data, deterministic initialization/replay,
  sleep normalization, and durable migration coverage.
- [ ] Host `Authenticator` implementations.
- [ ] Host `Store` implementations.
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

