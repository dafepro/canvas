# Library UX and maintainability audit

Audit date: 2026-08-27
Target release: 0.4.0
Scope: TypeScript packages, browser runtime, Go rooms SDK, examples, and public
documentation

## Executive result

This pass concentrated on seams where an apparently valid consumer action
could be ignored, select the wrong data, corrupt an engine dispatch loop, leak
browser resources, or require callers to coordinate multiple internal
milestones. Six vertical slices were implemented:

1. The Go configuration-schema subset now enforces every numeric and collection
   constraint it advertises and rejects unknown or contradictory schemas.
2. The rooms catalog now has one mandatory exact-version contract; the legacy
   ID-only adapter and optional capability split were removed.
3. Client observers are centrally failure-isolated, accept `AbortSignal`
   ownership, and report callback failures through a typed non-replaying error
   stream.
4. `CanvasRuntime.start()` now selects the safe presentation boundary by
   default, while explicit boundaries and connection-oriented `RoomSession`
   preserve lower-level control.
5. Local definitions and session rates fail before allocation, and the validated
   definition bundle is snapshotted so caller mutation cannot split the network,
   renderer, and worker views.
6. The full workspace type check now includes Node-backed example tests and is
   green; it exposed and corrected an invalid collider role, stale item fixtures,
   and a test-harness API that discarded discriminated-union narrowing.

The final 0.4.0 slice intentionally breaks the store adapter, browser startup,
duplicate-subscription, and mutation-message contracts. Their impact and
migrations are recorded in `MAJOR_VERSION_NOTES.md`.

## Method and independent review

The repository's public exports, examples, lifecycle, observer dispatch,
resource teardown, catalog storage, schema validation, and release checks were
traced before edits. A separate read-only agent then audited those same seams
without seeing an implementation plan. Its highest-priority findings were the
silently ignored schema keywords, ID-only version lookup, unisolated observers,
incomplete runtime cleanup, ambiguous startup gates, late local validation, and
unbounded rates. Implementation started only after that report, and each slice
was captured by a failing test or a regression example before its fix.

The independent reviewer then inspected the finished commits and rejected
several claims that were not yet fully true: the browser façade retained the
caller's definition array, rates remained mutable, two option callbacks could
still escape, document listeners preceded validation, scene cleanup could run
twice during mount, schema keywords could appear on the wrong value type, and
the external store kit did not prove two-version retention. Each was converted
into a focused regression and corrected before the release gate.

The 0.4.0 pre-publish recheck found two final contract gaps: the reference store
still shared caller-owned JSON bytes despite calling catalog generations
immutable, and the documented workspace type check was not a required CI step.
The store now copies catalog bytes at registration and read boundaries, and CI
now runs the same package/example/Node-test type check as the local release
gate. The conformance fixture also rejects a purported previous generation that
is not actually older.

## Implemented findings and proof

| Seam | Previous consumer experience | New contract | Automated proof |
| --- | --- | --- | --- |
| Authored configuration schemas | A schema could advertise `minimum`, `maximum`, exclusive bounds, item-count bounds, or uniqueness while the server accepted violating durable data. Typos, contradictory bounds, and constraints on the wrong value type were also accepted. | The supported subset is decoded strictly, checked for keyword/type applicability and internal consistency, and fully enforced. JSON numeric equality is used for uniqueness. | `server/pkg/roomsdk/config_schema_test.go` |
| Catalog versions | Registering v2 under an existing ID replaced v1, and an optional capability left legacy stores able to return the wrong generation. | `Store` has one mandatory exact ID/version lookup shape. Reference stores retain all versions and the conformance kit always requires two same-ID generations. | `server/pkg/roomsdk/store_test.go`, `room_template_test.go`, and `roomsdktest/store.go` |
| Observer dispatch | One throwing UI callback could prevent later callbacks and escape into engine code; callback-identity dedup also coupled otherwise independent owners. | Every runtime observer uses one failure-isolated primitive. Each call creates an independently owned registration with an idempotent unsubscribe and optional `{ signal }`. | `room-observers.test.ts`, `observers.test.ts`, `participant-roster.test.ts`, `runtime-lifecycle.test.ts`, fullscreen, overlay, and driver tests |
| Runtime teardown | Terminal failure did not consistently release route listeners, input controllers, overlay/fullscreen observers, internal subscriptions, and a partially mounted scene. A stop racing scene mount could revive or double-destroy resources. | Validation precedes listener allocation. Terminal lifecycle, explicit stop, failed mount, and stop-during-mount converge on idempotent browser-resource, application, and scene cleanup. | `canvas-runtime-mount.test.ts`, `asset-rendering.test.ts`, and `asset-pipeline.test.ts` |
| Startup readiness | The common safe reveal required callers to know that `start()` meant only transport-connected/JOIN-sent. | `CanvasRuntime.start()` defaults to the full presentation boundary; advanced clients can select `connected` or `initialized`, while low-level `RoomSession.start()` remains connection-oriented. | `runtime-lifecycle.test.ts` and `asset-pipeline.test.ts` prove both façade levels and typo handling. Examples use the default one-call form. |
| Local definitions and rates | Duplicate/invalid definitions failed only after network JOIN; zero, non-finite, negative, or extreme rates flowed into interval arithmetic; later caller mutation could change the already-validated bundle. | Construction emits typed `invalid_configuration` before allocation, rates are restricted to `(0, 240]`, and one immutable definition snapshot is shared by coordination, rendering, editing, and simulation. | `runtime-lifecycle.test.ts`, `asset-pipeline.test.ts`, and `canvas-runtime-mount.test.ts` cover initial and post-construction mutation plus listener-allocation order. |
| Example consumption and test helpers | The workspace type check skipped usable Node declarations and then exposed example items without required revisions, an unsupported `worldSolid` role, and `BehaviorTestHarness.commands(type)` returning the entire union. | Node-backed example tests type-check, content uses the public `worldStatic` role, fixtures satisfy the current item contract, and the harness narrows commands by their discriminant. | Clean package build, full `pnpm typecheck`, 49 focused example tests, and the linked-room canvasd E2E. |

## Before and after

### One owned route lifetime

Previously a route had to retain every returned function and separately compose
the presentation gate:

```ts
const offPresence = runtime.subscribePresence(renderRoster);
const offStartup = runtime.subscribeStartup(renderLoading);
await runtime.start();
await runtime.whenStartupReady();

offStartup();
offPresence();
await runtime.stopGracefully();
```

The same intent now has one standard ownership object and one readiness call:

```ts
const route = new AbortController();
runtime.subscribePresence(renderRoster, { signal: route.signal });
runtime.subscribeStartup(renderLoading, { signal: route.signal });
runtime.subscribeErrors(reportRecoverableFailure, { signal: route.signal });

await runtime.start();

route.abort();
await runtime.stopGracefully();
```

The returned unsubscribe functions remain available, so this is an ergonomic
addition rather than a forced ownership model.

### Safe rolling catalog deployment

A store has one exact-version catalog contract:

```go
type Store interface {
    LoadCanvas(context.Context, string, uint32) (CanvasRecord, error)
    LoadItemDefinition(context.Context, string, uint32) (ItemDefinitionRecord, error)
    // snapshot methods omitted
}
```

The SDK always requests the room template's exact version. Adapters key catalog
records by ID and version, so old and new durable rooms coexist predictably.

### Actionable consumer failures

A bad observer is isolated from other UI and engine work:

```ts
session.subscribePresence(() => {
  throw new Error("broken roster view");
});
session.subscribePresence(renderIndependentRoster);
session.subscribeErrors((error) => {
  if (error.code === "consumer_callback_failed") {
    reportUiFailure(error.details?.stream);
  }
});
```

`renderIndependentRoster` still runs. The error observer is also isolated, so
error reporting cannot recursively replace the original engine operation.

## Full findings ledger

| Finding | Decision | Rationale / next action |
| --- | --- | --- |
| Advertised schema constraints were ignored | Implemented | Silent acceptance of invalid durable configuration was a correctness bug. |
| Catalog lookup was ID-only | Implemented in the 0.4 breaking line | Exact lookup is mandatory so an adapter cannot silently violate durable room bindings. |
| Observer callbacks shared engine failure domains | Implemented | Centralization removes repeated unsafe loops and inconsistent cleanup semantics. |
| Runtime cleanup had parallel, incomplete paths | Implemented and independently rechecked | Idempotent scene/application teardown and an explicit stop-during-mount regression cover the race found on re-review. |
| Startup required callers to understand internal gates | Implemented in the 0.4 breaking line | The browser façade defaults to the safe reveal boundary; the low-level session retains connection timing. |
| Definitions were validated after JOIN | Implemented with noted timing change | Invalid local data should not consume a connection or reach a worker. |
| Session rates accepted invalid interval inputs | Implemented with explicit range | Rejecting is more diagnosable than platform-dependent timer clamping. |
| Validated definitions and rates remained caller-mutable | Implemented with noted behavior change | A running runtime now shares one frozen definition snapshot; rates are also snapshotted before later interval creation. |
| Public `regions[].fieldModifier` is validated but not applied by simulation | Deferred; do not author it as an active effect | Implementing force composition, overlap priority, host/peer determinism, and checkpoint semantics is a physics feature, not a safe UX-only patch. The next change should either implement it end-to-end with deterministic simulation tests or deprecate it before removal; silent no-op remains an acknowledged contract gap. |
| Server failures collapse to broad HTTP text/status responses | Deferred | A stable JSON error envelope needs an additive HTTP contract and client mapping. It should reuse machine codes rather than expose Go strings. |
| Example/content authoring duplicates large literal graphs | Deferred | A data/code-generation pipeline would reduce drift but needs a source-of-truth format and generated-file policy. Consolidating blindly would obscure otherwise independent examples. |
| Public declaration fingerprints expose release-test internals | Retained | They are repository release fixtures, not package exports. The 0.4.0 baseline must be regenerated only from clean declarations. |
| Package/build metadata can drift | Addressed by release gate | Coordinated package versions, clean builds, packed-consumer tests, and declaration fingerprints remain the appropriate proof. |
| Example tests and server JSON drifted from public types | Implemented | The strict workspace check is restored as a maintained consumer-level signal instead of being accepted as baseline noise. |

## Compatibility decisions

- Existing stores must migrate to mandatory exact-version lookups; latest-by-ID
  fallback has been removed.
- `RoomSession.start()` keeps connection timing; `CanvasRuntime.start()` now
  defaults to presented readiness.
- Existing unsubscribe-return ownership and `onError` callbacks remain valid,
  but duplicate callback registrations are independent.
- Schemas that depended on ignored constraints now fail as their authored
  schema says they should. Unsupported/contradictory schema shapes fail closed.
- Invalid definitions/rates now throw earlier, and post-construction definition
  mutation no longer affects a session. These changes are called out in the
  0.3.0 migration ledger. The intentional 0.4.0 breaks are recorded there too.
- Wire protocol v8 and snapshot schema 1 are unchanged.

## Release gate

The relevant gate for this pass is:

```text
pnpm -r --filter "./packages/*" build
pnpm exec vitest run <focused client, example, release, and package tests>
go -C server test ./pkg/roomsdk ./pkg/roomsdktest
```

The final handoff records the exact commands and outcomes. Docker-backed room
integration remains the preferred end-to-end proof where the changed boundary
crosses the service; purely local observer and startup semantics are exercised
deterministically without adding a network fixture that cannot affect them.
