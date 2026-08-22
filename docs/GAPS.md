# Prioritized implementation gaps

This backlog records the repository audit performed at commit
`f4bf0edf35526420abe88a173588c4294fcecf18`. Work proceeds from Priority 0
downward. Check an item only after the relevant focused tests pass.

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
- [ ] Restore behavior timers across active host migration so timer-driven
  workflows resume from their checkpointed remaining duration.
- [x] Reconcile avatar presence by adding only new peers and removing departed
  peers; eliminate duplicate avatars and ghost colliders.
- [ ] Wire behavior-state migrations into snapshot loading and preserve actual
  behavior/definition versions in checkpoints.
- [ ] Complete durable editing: public rotate and set-config APIs, live config
  application, preview handling, selection/ghost UI, rate limiting, and final
  release commits.
- [ ] Add a durable Store implementation for the reference service so process
  restarts preserve canvases and snapshots.

## Priority 2 — next phases

- [ ] Quantize transforms and remeasure the roughly 20 KB/s per-peer target.
- [ ] Profile host simulation and rendering on representative low-, mid-, and
  high-tier mobile devices, including suspended/background behavior.
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
- [ ] Add Windows/Linux CI and publishable package exports that target built
  JavaScript and declarations rather than TypeScript source.
