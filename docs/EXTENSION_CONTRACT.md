# Behavior extension contract

This contract defines how an application adds developer-authored behavior to
Canvas without modifying Canvas packages or sending executable code over the
network.

## Boundary

- A behavior is an `ItemBehavior` imported at build time by an
  application-owned worker entry.
- Worker messages remain data-only `SimulationRequest` and
  `SimulationResponse` values. Functions and behavior implementations never
  cross `postMessage` or the room transport.
- Behavior type names are globally unique within a worker. Registration fails
  immediately when an application collides with a built-in or another
  application behavior.
- Canvas owns the simulation runtime and generic commands. The application owns
  its domain behavior, definitions, art, and product policy.

## Worker entry

An application creates a module such as `canvas.worker.ts`:

```ts
/// <reference lib="webworker" />
import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { SoccerBallBehavior } from "./soccer-ball-behavior.js";

installSimulationWorker(self, [SoccerBallBehavior]);
```

The browser entry must construct the worker directly so tools such as Vite can
discover and bundle it statically. Load the runtime subpath and construct the
worker inside the route or Join action; the worker URL remains statically
discoverable without downloading either bundle on unrelated routes:

```ts
const joinCanvas = async () => {
  const { SimulationDriver } = await import("@canvas-physics/client/runtime");
  const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
    type: "module",
    name: "product-canvas-simulation",
  });
  return new SimulationDriver(worker);
};
```

Pass `driver` to `RoomSession`. Tests that do not need a real worker can call
`SimulationDriver.local([SoccerBallBehavior])` with the same behavior list.
Framework-neutral behavior checks and the headless harness are exported from
`@canvas-physics/core/testing`; see `CONFORMANCE_KITS.md`.

## Behavior requirements

- The behavior must be deterministic for a given ordered event stream and may
  only inspect the supplied `BehaviorContext`.
- It may affect the world only through returned `BehaviorCommand` values.
- Randomness must come from `BehaviorContext.random()`.
- Persistent state changes require a new `stateVersion` and a complete
  `MigrationChain`. These durable migrations do not imply wire-protocol
  backward compatibility.
- A definition that names the behavior must be supplied with the room before an
  instance using it is loaded.

## Acceptance test

The soccer integration runs its domain behavior through
`runBehaviorConformance` from the packed testing subpath.
`packages/client/test/custom-worker-runtime.test.ts` installs a custom behavior
through the public worker bootstrap, adds an item that uses it, and observes its
state advancing in worker responses. `test/package-artifacts.test.ts` also
imports the bootstrap from a clean install of packed release artifacts.
