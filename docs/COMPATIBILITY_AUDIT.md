# Layer compatibility audit

Audit date: 2026-08-27  
Release baseline: 0.2.0  
Wire baseline: protocol v8 / snapshot schema 1

## Goal and method

This audit treats Canvas as a library and rooms service used by external
application clients. Each issue was first captured by an automated failing
example, then fixed at the narrowest authority boundary plus a defensive
consumer boundary where corruption could otherwise propagate. A verified
vertical slice was committed before the next class of compatibility issue.

The audit covers published packages and subpaths, TypeScript/Go data domains,
protobuf declarations and generated bindings, definition negotiation, embedded
JSON, transport lifecycle and delivery semantics, room authority, durable
restart/reconciliation, worker initialization, and typed runtime failure
behavior.

## Contract matrix

| Surface | Enforced compatibility contract | Automated evidence |
| --- | --- | --- |
| Published packages | One immutable semantic version; clean builds remove stale declarations; packed tarballs install outside the workspace; public declarations are fingerprinted. | `test/package-artifacts.test.ts`, `test/release-contract.test.ts`, `test/library-boundaries.test.ts` |
| Repository tests | Workspace imports resolve source rather than whatever was left in `dist`. | `test/ci-contract.test.ts`, `vitest.config.ts` |
| Protobuf wire | Client/server exact protocol version matches; generated Go/TS bindings match the proto; every released v8 field/type/label/oneof, enum value, and reservation is frozen while additive fields remain possible. | `test/release-contract.test.ts`, `test/wire-compatibility.test.ts`, `scripts/verify-generated.sh` |
| Definition negotiation | Scene definitions match exact ID and version; duplicate JOIN IDs are rejected; a version mismatch removes host eligibility without disconnecting a peer. | `server/pkg/roomsdk/definitions_test.go`, `server/pkg/roomsdk/compatibility_test.go`, `packages/client/test/runtime-lifecycle.test.ts` |
| Canvas/item definitions | Versions fit `uint32`; nested renderer and physics numerics, shapes, masks, limits, spawn/respawn references, and IDs validate before worker initialization. | `packages/core/test/model.test.ts`, `packages/client/test/runtime-lifecycle.test.ts`, `server/pkg/roomsdk/system_items_test.go` |
| Snapshot JSON | Schema/canvas versions, JavaScript-safe counters, revisions, timers, transforms, limits, duplicate IDs, and numeric domains fail closed in TypeScript and Go. | `packages/core/test/model.test.ts`, `server/pkg/roomsdk/compatibility_test.go`, `server/pkg/roomsdk/room_test.go` |
| Embedded JSON | Malformed JOIN, host snapshot, mutation/edit result, effect, and behavior-state JSON emits a stable protocol error without partially applying lease or revision state. | `packages/client/test/room-client-json.test.ts`, `packages/client/test/runtime-lifecycle.test.ts`, `server/pkg/roomsdk/compatibility_test.go` |
| Realtime input | Direction/intensity/target and heartbeat health have finite bounded domains; invalid peer input is not relayed and invalid adapter input stops safely in physics. | `server/pkg/roomsdk/room_test.go`, `packages/client/test/host-simulation.test.ts`, `packages/client/test/two-client-relay.test.ts` |
| Client transport | Initial rejection is terminal and observable; reconnect retains bounded ordered reliable sends; realtime remains newest-value delivery. | `packages/client/test/websocket-credentials.test.ts`, `packages/client/test/room-transport-conformance.test.ts`, `packages/client/test/reconnect-join.test.ts` |
| Server delivery | Reliable traffic is never silently discarded: it displaces realtime backlog, backpressures inbound, or visibly closes a saturated slow connection. | `server/pkg/roomsdk/delivery_test.go` |
| Durable mutations | Mutations remain pending until a joined connection can send them and reliable transport retains them across reconnect. | `packages/client/test/item-mutation-session.test.ts`, `packages/client/test/reconnect-join.test.ts` |
| Restart/reconciliation | Room wake applies live-equivalent integrity checks; explicit template reconciliation alone may bridge declared canvas/version differences; resulting system items carry valid revisions. | `server/pkg/roomsdk/compatibility_test.go`, `server/pkg/roomsdk/room_test.go`, `server/pkg/roomsdk/system_items_test.go` |
| Runtime/worker lifecycle | Invalid JOIN/definition data fails before simulation initialization; initial/reconnect/terminal states and cleanup remain typed and deterministic. | `packages/client/test/runtime-lifecycle.test.ts`, `packages/client/test/connection-session.test.ts`, `packages/client/test/session-transition-model.test.ts`, `packages/client/test/custom-worker-runtime.test.ts` |
| Network integration | Host election, direct input, state repair, host migration, graceful restart, packet loss/reordering, and external package use execute through real service/encoded boundaries. | `packages/client/test/two-client-relay.test.ts`, `packages/client/test/packet-loss.test.ts`, `packages/client/test/graceful-sleep.test.ts`, example E2E suites |

## Findings ledger

| ID | Reproduced incompatibility | Resolution | Status |
| --- | --- | --- | --- |
| COMPAT-001 | Tests changed behavior depending on stale `dist` contents. | Alias workspace packages/subpaths to source in repository tests. | Closed |
| COMPAT-002 | A client with a newer definition could host an older scene and run different physics. | Require exact scene definition versions. | Closed |
| COMPAT-003 | Mutations and reliable messages submitted during reconnect were marked sent or silently dropped. | Gate mutation submission on JOIN readiness and retain a bounded encoded reliable queue. | Closed |
| COMPAT-004 | Server queue saturation discarded reliable and realtime envelopes identically. | Prioritize reliable delivery, backpressure inbound reliable traffic, and close visibly when reliable-only saturation cannot recover. | Closed |
| COMPAT-005 | Explicit zero limits, unsupported schemas, non-finite scale, and malformed JOIN/effect JSON were interpreted differently across layers. | Align Go/TypeScript defaults and fail-closed validation. | Closed |
| COMPAT-006 | Different artifacts could be handed off as version 0.1.0 and clean packs included declarations removed from source. | Establish coordinated 0.2.0 artifacts, clean builds, immutable fingerprints, and major-version notes. | Closed |
| COMPAT-007 | NaN/Infinity input could enter host election or physics velocity. | Validate server relay/heartbeat domains and sanitize the simulation boundary. | Closed |
| COMPAT-008 | JavaScript accepted versions protobuf could not represent; Go and TypeScript disagreed on the exact slack boundary and checkpoint canvas version. | Share uint32/safe-integer domains, metadata identity checks, and inclusive boundary semantics. | Closed |
| COMPAT-009 | Server configuration validation advertised numeric and collection constraints but ignored them, allowing invalid behavior and physics data into durable items. | Enforce every authored constraint and reject unsupported or inconsistent schemas explicitly. | Closed |
| COMPAT-009 | Initial credential/constructor failures rejected `connect()` but left a nonterminal transport status. | Make initial rejection transition exactly to `failed`; reserve retry for a previously open connection. | Closed |
| COMPAT-010 | Malformed protobuf-contained JSON threw through callbacks after mutating lease or revision state. | Decode before state mutation and emit stable malformed-payload errors. | Closed |
| COMPAT-011 | Duplicate or nested-invalid definitions could initialize maps, renderer, and worker with ambiguous or unsafe data. | Validate the complete definition/canvas bundle and reject duplicate JOIN IDs. | Closed |
| COMPAT-012 | `definition_mismatch` was documented as host ineligibility but the runtime treated it as a terminal room error. | Report it as a recoverable typed advisory and keep the peer active. | Closed |
| COMPAT-013 | Corrupt persisted state bypassed live checkpoint validation after room wake; reconciled system items had revision zero. | Apply wake integrity validation and materialize revision-one system items. | Closed |
| COMPAT-014 | Generated bindings could agree with a silently repurposed v8 proto declaration. | Freeze additive-friendly v8 wire signatures in the release gate. | Closed |

## Compatibility-sensitive behavior

The changes above preserve documented client behavior. They do intentionally
reject values that never met the now-explicit contract: non-finite/out-of-range
physics values, ambiguous duplicate definition IDs, unsupported snapshot
schemas, unsafe integer overflow, malformed embedded JSON, and corrupt durable
state. `docs/MAJOR_VERSION_NOTES.md` records these hardening migrations. No
backward-incompatible change is currently scheduled for the next major.

## Residual risks and required discipline

- The wire registry proves structural protobuf compatibility, not unchanged
  business meaning. A semantic reinterpretation still requires review, a
  protocol plan, and an entry in `MAJOR_VERSION_NOTES.md`.
- Protocol v8 remains exact-match. A future incompatible wire rollout needs a
  staged server/client bridge or a documented coordinated deployment; this
  audit does not invent multi-version support.
- Consumer transports and stores are outside this repository. They must run the
  exported conformance kits, and production implementations still require their
  own fault, durability, and credential-expiry testing.
- Browser engines, proxies, and storage backends have failure modes no finite
  local suite can exhaust. The deterministic packet-loss/reorder, reconnect,
  restart, queue-saturation, and packed-consumer tests are the maintained
  regression boundary for the classes found here.

## Verification gate

The final audit gate is:

```text
pnpm -r --filter "./packages/*" build
pnpm vitest run --exclude packages/client/test/load-budget.test.ts
pnpm vitest run packages/client/test/load-budget.test.ts
go -C server test ./...
```

CI additionally regenerates both protobuf bindings and runs the Go race suite
on Linux.
