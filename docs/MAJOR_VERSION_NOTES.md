# Backward-incompatibility notes

This is the cumulative migration ledger for incompatible changes. Entries stay
under **Next release** until that release ships; release sections remain as the
historical migration record. Each entry must name the affected contract, client
impact, and required migration.

## Next release (unreleased)

No backward-incompatible changes are currently scheduled.

## 0.4.0

- **Exact-version Store contract:** `roomsdk.Store.LoadCanvas` and
  `LoadItemDefinition` now require a `version uint32`; the ID-only methods,
  `VersionedCatalogStore`, and `Load*Version` names were removed. Every adapter
  must retain all catalog generations needed by durable rooms. Client impact:
  existing Go store adapters no longer compile, and conformance fixtures must
  always seed both current and previous generations. Migration: add the version
  parameter to both methods, key records by `(ID, version)`, return
  `roomsdk.ErrNotFound` for an absent pair, and provide non-pointer
  `PreviousCanvas` and `PreviousItemDefinition` fixtures.
- **Definition rejection reason:** spawn and configuration mutations that name
  an unavailable `(definitionId, version)` now report
  `unknown_definition_version`; `unknown_definition` and
  `definition_version_mismatch` are no longer emitted. The protobuf reject code
  remains `ITEM_MUTATION_REJECT_DEFINITION`. Client impact: UI or telemetry
  branching on the result message must recognize the combined reason.
  Migration: branch on the stable reject enum when possible, or replace both
  legacy strings with `unknown_definition_version`.
- **CanvasRuntime startup default:** `CanvasRuntime.start()` now waits for the
  complete presentation boundary, including required assets, authoritative
  canonical state, scene mount, and first renderer update. Client impact: code
  that awaited no-argument `start()` merely to inject test traffic or perform
  work while JOIN was pending may now wait longer. Migration: ordinary browser
  routes should keep `await runtime.start()`; low-level consumers can request
  `start({ until: "connected" })`. `RoomSession.start()` remains
  connection-oriented and unchanged.
- **Independent subscription registrations:** subscribing the same callback
  more than once now creates multiple registrations and notifications. Each
  returned unsubscribe function or `AbortSignal` owns only its registration.
  Client impact: code that relied on callback-identity deduplication receives
  one notification per subscription. Migration: subscribe once when one
  notification is intended, and retain or abort each registration separately.

## 0.3.0

- **Client configuration validation timing:** malformed or duplicate local item
  definitions and invalid session rates now throw a typed
  `invalid_configuration` error while constructing `RoomSession` or
  `CanvasRuntime`, before a worker or connection can observe the bundle.
  Configured rates must be finite, greater than zero, and no more than 240 Hz.
  Validated definitions are snapshotted, so mutating the caller's source array
  or nested objects later no longer changes a running session. Client impact:
  applications that dynamically assemble unvalidated options may see an
  earlier synchronous error, and code that intentionally mutates definitions
  after construction no longer affects the runtime. Migration: validate or
  construct configuration inside the application's error boundary, keep rates
  in the published range, and create a new runtime when definitions change.
- **Versioned store conformance fixtures:** a fixture whose store implements
  `VersionedCatalogStore` must now provide and preseed `PreviousCanvas` and
  `PreviousItemDefinition`. Client impact: external adapter conformance tests
  that only supplied the current generation now fail with an actionable fixture
  error. Migration: add an older record under each current ID so the suite can
  prove coexistence rather than only requested-version comparison.

## Compatibility hardening after 0.1.0

These corrections preserve the intended public surface but may expose clients
or adapters that depended on previously under-specified behavior:

- **Custom `RoomTransport` adapters:** reliable messages submitted during a
  reconnect must be retained and delivered in order after the connection
  reopens. Migration: buffer reliable encoded messages across temporary
  disconnects and run `runRoomTransportConformance`.
- **Item definition negotiation:** only the exact definition version used by a
  live scene is host-compatible. Migration: retain every definition version
  needed by deployed rooms or migrate the room template and durable items as one
  reconciled operation.
- **Canvas limits:** explicit `maxItems: 0` and
  `maxComplexPhysicsItems: 0` mean that no such items are permitted; only omitted
  fields receive defaults. Migration: omit a limit to request the default, or
  configure the intended positive limit explicitly.
- **Snapshot and numeric validation:** unknown snapshot schemas, non-finite
  mutation values, malformed embedded JSON, invalid definition/canvas physics,
  duplicate JOIN definition IDs, cross-language integer overflow, and invalid
  limit shapes are rejected instead of being accepted and partially
  interpreted. Migration: emit snapshot schema 1, advertise each definition ID
  once, and supply values satisfying the published core validators.
- **Item configuration schemas:** the rooms SDK now enforces the numeric and
  collection constraints it advertises (`minimum`, `maximum`, exclusive
  bounds, `minItems`, `maxItems`, and `uniqueItems`) and rejects unsupported or
  internally inconsistent schema keywords instead of silently ignoring them.
  Migration: keep schemas within the documented rooms SDK subset and ensure
  durable item configuration satisfies every authored constraint.
- **Consumer callback isolation:** throwing lifecycle, state, effect,
  mutation, fullscreen, overlay, diagnostics, or option callbacks no longer
  escape into transport, simulation, or render dispatch. Migration: observe
  `consumer_callback_failed` through `onError` or `subscribeErrors` for
  recoverable UI failures instead of relying on exceptions to propagate.

## Historical wire migration: protocol v4

- **Affected contract:** room HTTP/WebSocket routes and JOIN identity.
- **Client impact:** canvas-instance routes and the JOIN `canvas_id` field were
  removed when product room IDs were separated from reusable canvas templates.
- **Migration:** use `/v1/rooms/{roomId}` and
  `/v1/realtime/rooms/{roomId}`; send `room_id` in JOIN and read the selected
  `canvas_id` from `JoinAccepted`.
