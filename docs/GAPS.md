# Prioritized implementation gaps

This backlog records the repository audit performed at commit
`f4bf0edf35526420abe88a173588c4294fcecf18`. Work proceeds from Priority 0
downward. Check an item only after the relevant focused tests pass.

## Reference integrations — executable consumer contracts

- [x] Define an examples contract: every reference integration is independently
  runnable, imports only public package exports, owns its domain behavior and
  assets, and documents the product capabilities and library gaps it exercises.
- [x] Ship the soccer lounge as the first independently runnable reference
  integration, including field art and collision geometry, a custom match-ball
  behavior, shared scoring, live damped net physics, rear goal boundaries, and
  center reset.
- [x] Ship a compact item-management playground demonstrating consumer-owned
  art, behavior effects, spawn, drag, rotate, scale, configure, delete, and
  server-enforced participant and system ownership.
- [x] Exercise every reference integration from clean installs of packed Canvas
  artifacts so examples detect accidental internal imports and missing release
  files.
- [x] Add a server bootstrap API for system-owned template items so a room can
  contain exactly one canonical match ball without a user-owned spawn race.
- [x] Add stable participant identity and lifecycle projection so a product can
  retain disconnected roster members, deactivate their physics entities, and
  render them in a bench area. The soccer example owns deterministic bench and
  return-to-field placement through the generic lifecycle projector.
- [x] Connect the player presentation layer in the soccer integration. Canvas
  renders consumer-configured avatar art while the product owns compact names,
  deterministic one-to-five-star crowns, and lifecycle-aware bench styling via
  bounded overlay projections.
- [x] Move example art onto the versioned Canvas asset-manifest/preload pipeline.
  The soccer field and generated ball atlas now load as ordinary consumer-owned
  assets; collision geometry remains independent data.
- [x] Specify and tune avatar-to-item tangential contact for sports integrations.
  The soccer behavior exposes lateral impulse, spin transfer/radius, and
  angular-speed limits as consumer configuration. Mirrored glancing-kick tests
  verify the screen-coordinate rotation sign, while `?kickAnimation=0` hides
  deformation art without disabling physical rotation.
- [x] Ship a linked-rooms reference integration demonstrating a reliable
  collision-triggered room replacement, destination staging, exact reverse
  routes, failed-open rollback, departure-hidden avatars, a programmatic Back
  escape hatch, and a branching pixel-art room with an independently kickable
  physics item.
- [x] Ship a basketball reference integration proving that a consumer can put
  hoop geometry, score sensors, team tags, sport tuning, win thresholds, and
  possession/game resets in canvas and item configuration while keeping only
  generic event interpretation in its custom behavior.

## Consumer-library Priority 0 — linked room travel

- [x] Define the trust and lifecycle boundary for host-authored travel requests,
  consumer authorization, destination credentials, staging, and origin rollback.
- [x] Add a built-in avatar-only room-threshold behavior and immutable
  bidirectional room-link validation.
- [x] Add a renderer-independent linked-room navigator with local-avatar
  targeting, transition coalescing, reverse-link history, and `back()`.
- [x] Prove the public contract through a packed, independently runnable
  linked-rooms reference integration.
- [x] Harden staged travel against initialization/host-grant races, activation
  and subscription rollback, throwing consumer callbacks, ignored arrival
  spawns, refresh ambiguity, duplicate same-room sessions, and edge-triggered
  portal geometry. Persist the failure matrix in
  `LINKED_ROOM_TRAVEL_HARDENING.md`.
- [x] Gate destination reveal on complete canonical presentation, render avatars
  above door art, expose duplicate-session takeover UI, and preserve validated
  canonical avatar positions across refresh and host promotion. Explicit door
  arrival spawns override saved positions.
- [ ] Define an optional product-owned participant-location lease conformance
  adapter for worlds that require one global room per authenticated account.
  Canvas rooms remain independent and do not impose this policy themselves.
- [x] Define multi-process room ownership with an optional shared coordinator,
  monotonic snapshot fencing, lease renewal/loss, and bounded graceful drain.
  `ROOM_OWNERSHIP.md` distinguishes routing affinity, coordination, shared
  storage, and authentication; public adapter conformance covers the boundary.
- [ ] Add fault injection at every linked-room transaction boundary and a
  configurable retention policy for saved participant positions.

## Consumer-library Priority 0 — current structural blockers

These gaps were identified while designing the first external product
integration. They take precedence over the older Priority 2 and Priority 3
work below because they determine the public boundary every consumer will use.

- [x] Publish JavaScript, declaration, and worker artifacts that can be packed
  and installed outside this workspace.
- [x] Let an application register custom behaviors in its simulation worker
  without editing or forking Canvas core.
- [x] Replace identity query parameters with an asynchronous credential provider
  that is called for every connection and reconnect. Require production hosts
  to configure authentication explicitly.
- [x] Expose immutable public subscriptions for authenticated presence,
  canonical entities, behavior state, and effects.
- [x] Specify and enforce the product boundary: Canvas owns generic simulation,
  rendering, synchronization, and room infrastructure; consumers own domain
  rules, content, and product state.
- [x] Define the client compatibility and release policy: immutable coordinated
  JavaScript, Go SDK, generated protocol, and worker versions; additive changes
  within a supported major line; fail-fast schema mismatches; and cumulative
  migration notes for unavoidable breaks.

## Consumer-library Priority 1 — major completeness gaps

- [x] Replace competing avatar and item-edit DOM listeners with one exclusive
  pointer interaction coordinator. Built-in and consumer strategies now use
  explicit priority claims, one capture/window lifecycle, exactly-once
  terminals, runtime-driven cancellation, diagnostics, and a public extension
  contract with failure isolation.
- [x] Complete asset manifests, preload gates, backgrounds, sprites, atlases,
  animations, deterministic asset versions, and failure fallbacks.
- [x] Make the runtime and worker lazy-loadable so unrelated consumer routes do
  not download Canvas. The public `@canvas-physics/client/runtime` subpath is a
  dynamic-import boundary, the application worker is constructed only on Join,
  and the packed soccer consumer enforces a sub-100 KB eager browser entry.
- [x] Distinguish stable authenticated participant identity from ephemeral
  connection and physics-entity IDs. Reconnects supersede stale sockets while
  retaining one `avatar:<participantId>` entity and an immutable lifecycle
  tombstone for the observing session.
- [x] Provide dynamic room-template selection and version-reconciliation APIs.
  Product room IDs now resolve through a required host port to exact reusable
  canvas templates, snapshots persist that binding independently per room, and
  conflicting resolver changes fail closed. Explicit offline reconciliation
  can adopt a new template/version and add, replace, or retire desired system
  items with participant-item protection.
- [x] Define start, stop, reconnect, remount, background, and route-unmount
  lifecycle behavior with a typed consumer error model.
- [x] Provide renderer-safe projection and bounded overlay observation helpers.
- [x] Replace anonymous item edits with acknowledged mutation receipts,
  per-item revisions and queues, server edit leases, idempotent reconnect
  retries, sequenced previews, and canonical-revision presentation release.
  The item studio consumes matching receipts and the superseded wire path was
  deleted rather than retained as a compatibility branch.

## Consumer-library Priority 2 — proof and hardening

- [x] Add external-consumer conformance kits for behaviors, authentication,
  stores, transports, and custom worker bundles.
  - [x] Behavior metadata, deterministic replay, sleep normalization, and
    durable migration cases through `@canvas-physics/core/testing`.
  - [x] Host authentication adapters through the Go `roomsdktest` package.
  - [x] Host stores, including stale/concurrent ordering and optional durable
    adapter reopen, through the Go `roomsdktest` package.
  - [x] Custom room transports through the framework-neutral
    `@canvas-physics/client/testing` fixture, including lifecycle, ordered and
    realtime delivery, listener cleanup, reconnect recovery, counters, and
    caller close.
  - [x] Application-owned worker bundles through
    `runSimulationWorkerConformance`, including readiness, snapshots,
    representative application behavior, listener cleanup, and quiet stop.
- [x] Exercise packed release artifacts from separate fixture applications,
  including both reference integrations and their custom worker bundles.
- [x] Complete latency, loss, reordering, reconnect, migration, late-join, and
  lifecycle-driven backgrounding coverage.
  - [x] Deterministic inbound/outbound realtime loss with keyframe repair.
  - [x] Real-process convergence at 50, 100, and 200 ms one-way inbound latency
    while every second realtime packet is reordered.
  - [x] Baseline reconnect, moving/timer host migration, sleeping-room restart,
    and mid-workflow late-join cases.
  - [x] Combine reconnect and moving/workflow host migration with injected
    latency and reordering.
  - [x] Add a background/reconnect/resume case under injected faults. JOIN now
    carries hidden state so a suspended client cannot briefly win the host lease
    while reconnecting.
- [ ] Record physical-device resource profiles and enforce measured budgets.
- [x] Add reproducible Windows/Linux release CI with generated-code verification.
  Both operating systems build and test the library, Linux additionally runs Go
  race detection, packed external consumers exercise public artifacts, and a
  separate pinned generation job rejects stale TypeScript or Go protobuf bindings.
- [ ] Expose an owner-authorized transient item-action path from the public
  runtime through the relay to the host behavior. This is needed for generic
  Play, Restart, and named trigger controls that should not masquerade as
  durable configuration changes.

## Consumer-library Priority 3 — optional follow-ups

- [ ] Add visual extension labs and additional overlay/diagnostic conveniences.
- [ ] Add generic transient render projections with clip/mask geometry. This
  would let one canonical physics body appear partially at two mapped locations
  during a seamless portal crossing, and would also support mirrors, windows,
  and other consumer-authored projection effects without exposing Pixi internals.
- [ ] Complete elevation and richer animation support.
- [ ] Evaluate WebRTC only if measured WebSocket performance warrants it.

## Priority 0 — structural fixes

- [x] Separate host-authored physics from server-authoritative durable item data.
  Checkpoints may update permitted canonical fields only; they must not add or
  delete items or change ownership, definitions, resolved config, or scene
  revision. Reject unknown IDs, invalid transforms, stale revisions, and stale
  checkpoint numbers.
- [x] Introduce an explicit JOIN/reconnect state machine. Validate JOIN,
  protocol compatibility, and definition compatibility before room admission or
  host election. Resend JOIN after reconnect and freeze shared simulation while
  disconnected.
- [x] Make item definitions and configuration schemas authoritative server
  metadata. Validate definition IDs and versions, resolved config, and
  `maxComplexPhysicsItems` before accepting a spawn or config mutation.
- [x] Define and implement room-sleep normalization ownership. Preserve a
  monotonically increasing `hostEpoch` across room sleep/wake, produce a real
  normalized final snapshot, and handle abrupt host loss without pretending an
  unnormalized snapshot is normalized.

## Priority 1 — large gaps in completed phases

- [x] Restore checkpoint sequencing during host migration and wake; do not emit
  stale checkpoints until a new host catches up.
- [x] Preserve canonical ticks, checkpointed behavior phases and visuals, and
  avatar positions across active host migration instead of treating every
  loaded checkpoint as `room.wake`.
- [x] Restore behavior timers across active host migration so timer-driven
  workflows resume from their checkpointed remaining duration.
- [x] Reconcile avatar presence by adding only new peers and removing departed
  peers; eliminate duplicate avatars and ghost colliders.
- [x] Keep peer-local avatar prediction stable across keyframes and periodic
  checkpoints. Host and peer now derive the same deterministic spawn offset,
  and display correction observes each canonical tick once before easing toward
  its newest error instead of reapplying delayed state every render frame.
- [x] Redesign direct avatar dragging at canvas edges. Pointer ownership now has
  explicit held/suspended lifecycle, direct placement continuously resolves
  compound fixed-geometry contacts, and delayed canonical state reconciles
  against the prediction for its acknowledged input sequence rather than the
  newest pointer target. The all-edge/corner, capture-loss, and delayed-relay
  matrices cover leaving, sliding, returning, releasing, and re-grabbing.
- [x] Wire behavior-state migrations into snapshot loading and preserve actual
  behavior/definition versions in checkpoints.
- [x] Add public rotate and set-config APIs, use server-authoritative accepted
  transforms, and apply accepted configuration to the live host behavior.
- [x] Add authoritative uniform item scaling across durable transforms,
  protocol, persistence, interpolation, rendering, and collider geometry.
- [x] Relay leased, sequenced owner previews to the host without persisting
  them, coalesce each edit stream to a bounded realtime send rate, and send an
  acknowledged release mutation immediately.
- [x] Add explicit edit mode with owner-only item selection, a local drag ghost,
  rate-limited preview moves, and a final release commit.
- [x] Add a durable Store implementation for the reference service so process
  restarts preserve canvases and snapshots.

## Priority 2 — next phases

- [x] Quantize transforms and remeasure the roughly 20 KB/s per-peer target.
  Fixed-point transforms reduced the measured full-churn rate from 41.6 to
  32.7 KB/s and the moving-avatar rate from 46.4 to 37.1 KB/s. Busy scenes
  remain above the guidance and should be addressed only after device profiles
  identify whether bandwidth or rendering is the next limiting resource.
- [ ] Profile host simulation and rendering on representative low-, mid-, and
  high-tier mobile devices, including suspended/background behavior. Rolling
  p95/worst/long-frame metrics, background duration counters, and the repeatable
  capture protocol are in place; physical-device results remain outstanding.
- [x] Add asset manifests, preloading, texture-atlas rendering, and synchronized
  animation playback.
- [x] Split the renderer and simulation worker into lazy consumer bundles. This
  is enforced by the consumer-library Priority 1 packed-build contract above.
- [ ] Finish elevation rendering and behavior: scale, shadows, and
  elevation-dependent ground collision participation.
- [ ] Complete physical mobile-browser backgrounding coverage. Faulted
  background/reconnect/resume, simultaneous multi-avatar pushing, faulted
  reconnect and moving/workflow host migration, plus deterministic packet
  reordering and 50/100/200 ms latency tiers, are covered above.
- [ ] Evaluate optional WebRTC only after quantization and relay measurements;
  keep it behind `RoomTransport`.

## Priority 3 — smaller follow-ups

- [x] Render avatars from definition data. A consumer may register visual data
  for the reserved `avatar` definition; the neutral Canvas circle remains the
  fallback when no avatar visual is supplied.
- [x] Connect `startAnimation` to the renderer/network path, including replaying
  the same named animation through a synchronized animation epoch.
- [x] Correct peer item counts.
- [x] Correct host-migration diagnostics. Both observers and the client promoted
  to replacement host count the migration and retain the server's reason.
- [ ] Add collision, network, environment, and behavior visual laboratories.
- [x] Make the integration harness use the correct executable name on Windows.
- [x] Add Windows/Linux CI. Publishable package exports and generated bindings
  are enforced by the cross-platform release gate above.

Potential pre-1.0 rewrites discovered through recurring fixes are assessed in
`FEATURE_REDESIGN_CANDIDATES.md`; that note is evidence-driven and is not a
second compatibility promise or release checklist.
