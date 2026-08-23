# Prioritized implementation gaps

This backlog records the repository audit performed at commit
`f4bf0edf35526420abe88a173588c4294fcecf18`. Work proceeds from Priority 0
downward. Check an item only after the relevant focused tests pass.

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
- [ ] Expose immutable public subscriptions for authenticated presence,
  canonical entities, behavior state, and effects.
- [ ] Specify and enforce the product boundary: Canvas owns generic simulation,
  rendering, synchronization, and room infrastructure; consumers own domain
  rules, content, and product state.
- [ ] Define the prerelease compatibility and release policy: exact protocol
  matches; coordinated JavaScript, Go SDK, generated protocol, and worker
  versions; and fail-fast mismatches with no legacy or compatibility branches.

## Consumer-library Priority 1 — major completeness gaps

- [ ] Complete asset manifests, preload gates, backgrounds, sprites, atlases,
  animations, deterministic asset versions, and failure fallbacks.
- [ ] Make the runtime and worker lazy-loadable so unrelated consumer routes do
  not download Canvas.
- [ ] Distinguish stable authenticated participant identity from ephemeral
  connection and physics-entity IDs.
- [ ] Provide dynamic room-template and system-owned item bootstrap APIs.
- [ ] Define start, stop, reconnect, remount, background, and route-unmount
  lifecycle behavior with a typed consumer error model.
- [ ] Provide renderer-safe projection and bounded overlay observation helpers.

## Consumer-library Priority 2 — proof and hardening

- [ ] Add external-consumer conformance kits for behaviors, authentication,
  stores, transports, and custom worker bundles.
- [ ] Exercise packed release artifacts from a separate fixture application.
- [ ] Complete latency, loss, reordering, reconnect, migration, late-join, and
  mobile backgrounding coverage.
- [ ] Record physical-device resource profiles and enforce measured budgets.
- [ ] Add reproducible Windows/Linux release CI with generated-code verification.

## Consumer-library Priority 3 — optional follow-ups

- [ ] Add visual extension labs and additional overlay/diagnostic conveniences.
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
- [x] Wire behavior-state migrations into snapshot loading and preserve actual
  behavior/definition versions in checkpoints.
- [x] Add public rotate and set-config APIs, use server-authoritative accepted
  transforms, and apply accepted configuration to the live host behavior.
- [x] Relay owner move previews to the host without persisting them, coalesce
  preview bursts to a bounded reliable send rate, and send release commits
  immediately.
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
- [ ] Add asset manifests, preloading, texture-atlas rendering, animation
  playback, and bundle splitting.
- [ ] Finish elevation rendering and behavior: scale, shadows, and
  elevation-dependent ground collision participation.
- [ ] Complete multiplayer coverage for packet reordering, 50/100/200 ms
  latency, moving/workflow host migration, multi-avatar pushing, and mobile
  backgrounding.
- [ ] Evaluate optional WebRTC only after quantization and relay measurements;
  keep it behind `RoomTransport`.

## Priority 3 — smaller follow-ups

- [ ] Render avatars from definition data.
- [ ] Preserve networked effect parameters and connect `startAnimation` to the
  renderer/network path.
- [x] Correct peer item counts.
- [ ] Correct host-migration diagnostics.
- [ ] Add collision, network, environment, and behavior visual laboratories.
- [x] Make the integration harness use the correct executable name on Windows.
- [ ] Add Windows/Linux CI. Publishable package exports are now tracked as the
  first consumer-library Priority 0 item above.
