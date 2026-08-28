# Canvas 0.6.0

Canvas 0.6.0 adds application-authorized durable mutations, trusted mutation
reconciliation, fenced multi-process room ownership, and authenticated
transient behavior actions. It is additive and keeps protocol version 8: old
clients ignore the new action fields, and existing single-process hosts retain
their previous behavior unless they configure a new application seam.

## Application-authorized durable mutations

- Optional `MutationAuthorizer` policy receives authenticated participant,
  room/canvas binding, normalized proposed state, opaque bounded evidence, and
  a stable idempotency identity after Canvas validation.
- Denial and infrastructure failures use distinct stable rejection codes;
  timeouts, errors, and panics fail closed without consuming permits twice.
- The public authorizer conformance kit verifies binding and replay behavior.

## Trusted mutation-outcome reconciliation

- `Server.ReconcileMutation` reads accepted, rejected, unknown, or expired
  outcomes from a private durable ledger; no browser-facing query is exposed.
- Retention, capacity, sink delivery, metrics, receipts, and high-water state
  survive room sleep and shared-store service replacement.

## Fenced multi-process ownership

- Hosts can configure an optional `RoomCoordinator`; nil preserves the existing
  process-local model. Shared adapters grant one expiring owner with a monotonic
  fencing generation.
- Snapshot stores reject obsolete generations before comparing checkpoint or
  scene revisions, preventing a stale owner from overwriting a failover.
- Authority-bearing messages validate the current lease. Renewal loss closes
  stale clients, while `Server.Drain` checkpoints, releases, and waits for a
  bounded graceful handoff.
- New metrics and `RunRoomCoordinatorConformance` cover acquisition, renewal,
  release, expiry, fencing, concurrency, cancellation, and adapter restart.

## Authenticated transient actions

- `RoomSession` and `CanvasRuntime` submit named room or owned-item actions with
  bounded JSON and generated request IDs, receiving one stable accepted or
  rejected result.
- The server derives participant identity from authentication, enforces item
  ownership, applies product action/schema policy through
  `TransientActionRegistry`, and routes accepted events to the active host
  behavior.
- A bounded active-room ledger prevents duplicate behavior dispatch. Actions
  are current-connection-only, never stored in snapshots, and never replayed on
  reconnect, late join, or wake.
- Separate ingress, per-participant rate limits, stable rejection codes, and
  metrics keep action traffic observable without starving durable state.

## Compatibility and migration

- Protocol version remains 8; fields 30 and 31 and their message/enum types are
  additive and recorded in the v8 wire baseline.
- Existing `RoomTransport` implementations remain source-compatible because
  `sendEphemeralReliable` is optional. They must implement it to enable the new
  transient-action API without reconnect replay.
- Existing `Store` implementations remain source-compatible. Shared-owner
  deployments must persist `RoomOwnershipGeneration` and reject an older
  generation; the updated store conformance suite verifies this requirement.

See `ITEM_MUTATIONS.md`, `ROOM_OWNERSHIP.md`, and `TRANSIENT_ACTIONS.md` for the
integration contracts.
