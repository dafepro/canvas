# Acknowledged item mutations

Canvas item changes are reliable transactions. A local visual change is never
treated as proof that the relay accepted it: every public mutation returns a
receipt whose `settled` promise reaches exactly one terminal outcome.

```ts
const receipt = runtime.setItemConfig(entityId, { theme: "gold" });
const outcome = await receipt.settled;

if (outcome.status === "accepted") {
  console.log("canonical at", outcome.sceneRevision, outcome.itemRevision);
} else if (outcome.status === "rejected") {
  console.warn(outcome.code, outcome.message, outcome.authoritativeItem);
}
```

`spawnItem`, `moveItem`, `rotateItem`, `scaleItem`, `setItemConfig`,
`setItemIsolation`, `setItemCollisionsEnabled`, and `deleteItem` all return an
`ItemMutationReceipt`. Expected authorization, validation, conflict, and edit
lease failures settle the receipt as `rejected`; they are not reported as
transport failures through `onError`.

Every mutation method also accepts an additive `ItemMutationOptions` argument.
Applications can attach opaque authorization evidence and a reconciliation ID
without putting either value in canonical room state:

```ts
const receipt = runtime.spawnItem("earned-trophy", at, 0, 1, {
  authorizationEvidence: signedPermit,
  applicationCorrelationId: reservationId,
});
```

Evidence is copied into the reliable request and is never relayed to peers,
included in a mutation result, or stored in the public snapshot. The default
server bound is 4096 bytes (`MaxMutationAuthorizationBytes`); correlation IDs
default to 256 bytes (`MaxMutationCorrelationBytes`).

## Application authorization

A Go host can set `Config.MutationAuthorizer`. Canvas first completes its own
shape, ownership, exact-definition, configuration, capacity, item-revision,
and edit-lease checks. Only an otherwise-valid mutation reaches
`AuthorizeMutation`, so an invalid crafted request cannot consume a product
permit.

The immutable `MutationAuthorizationRequest` contains the authenticated
`Identity`, room and canvas ID/version, stable `MutationKind`, target entity and
exact definition version, deep-copied current and normalized proposed items,
opaque evidence and correlation, and a stable SHA-256 idempotency key derived
from participant, room, client session, and mutation ID. Product code can bind
its evidence to any subset of those values plus its own expiration and one-use
reservation semantics. Canvas does not interpret the evidence.

The decision timeout defaults to two seconds and is configured with
`MutationAuthorizationTimeout`. A policy denial settles as
`application_policy`; a timeout, returned error, or panic settles as
`application_unavailable`. Both fail closed without changing an item or public
revision. A retained duplicate returns the original receipt before invoking
the authorizer, so one logical mutation cannot consume a permit twice. With no
authorizer configured, legacy behavior is unchanged.

Host applications can run `roomsdktest.RunMutationAuthorizerConformance` with
their own opaque evidence. It covers approved, denied, expired, wrong-room,
wrong-participant, and replayed permits. Canvas's room-boundary suite separately
proves structural-check ordering, reconnect deduplication, timeouts, returned
errors, and panics over a real WebSocket room.

Use `runtime.subscribeItemMutations(...)` when a product needs a global pending
indicator or audit-style UI. The observer receives a frozen, replayed snapshot
of pending mutations and the most recent outcome. Prefer the individual
receipt for button text because unrelated room changes cannot accidentally
mark that action successful.

## Concurrency and retries

Each item carries an `itemRevision`. Canvas serializes local writes to the same
item and sends the next write using the revision returned by the preceding
result; writes to different items can proceed concurrently. A stale same-item
write is rejected with `stale_item_revision` and includes the authoritative
item when available.

The runtime keeps one logical `clientSessionId` across socket reconnects and
resends an unacknowledged mutation with the same numeric ID. The relay persists
a bounded receipt ledger keyed by authenticated user, client session, and
mutation ID. A retry therefore returns the original result without applying
the change twice. An ID older than the retained window is rejected with
`receipt_expired` rather than guessed.

## Direct manipulation

Tapping an owned item opens a short edit lease. Local drag presentation updates
at display cadence, while sequenced previews are rate-limited and disposable.
On release, the runtime sends a durable transform mutation. The local pose is
held until the matching accepted scene revision and authoritative transform
appear in canonical state; there is no latency timeout that can snap the item
back early.

Only one live preview lease exists per item. A competing editor receives
`edit_in_use`. Disconnect, expiry, explicit cancellation, or selection change
ends the lease and sends the committed transform back to the simulation host.
A new host receives the canonical snapshot before the relay replays the latest
valid previews.

## Rejection codes

The stable codes are `malformed`, `not_found`, `system_owned`, `not_owner`,
`edit_in_use`, `edit_expired`, `stale_item_revision`, `outside_canvas`,
`scale_out_of_range`, `definition`, `config`, `capacity`, `receipt_expired`,
`internal`, `application_policy`, `application_unavailable`, and
`application_correlation_conflict`. Consumers own user-facing wording. The optional `message` is a
diagnostic and must not be parsed as a contract.

## Trusted reconciliation

When `applicationCorrelationId` is present, Canvas synchronously adds the
terminal result to the server-private snapshot record before acknowledging it.
`Server.ReconcileMutation(ctx, roomID, correlationID)` is an in-process Go SDK
method and is deliberately not mounted by `Server.Handler`; browsers cannot
query the ledger, author accepted results, or replace the authenticated
participant recorded by Canvas.

An accepted `MutationOutcome` identifies the room, authenticated participant,
mutation kind, canonical entity, exact definition version, scene revision, and
item revision. A rejected outcome contains a stable `MutationRejectCode`.
`unknown` and `expired` are explicit non-evidence states and must never be
treated as a rejection that authorizes a release or refund. Repeated lookups
return the same value, and a retained correlation cannot be rebound to another
mutation or participant.

The default reconciliation window is 24 hours and 1024 outcomes per room.
Configure it with `MutationOutcomeRetention` and
`MaxMutationOutcomesPerRoom`; inspect the live contract with
`Server.MutationOutcomePolicy()`. The reference metrics exporter reports
recorded/reconciled outcomes, the retained count, and notification failures.
External Store conformance round-trips the private ledger and its ordering
revision so a service replacement can reconcile without waking the room.

`MutationOutcomeSink` is an optional best-effort notification seam. Canvas
invokes it only after durable recording. A sink timeout or error is logged and
counted but never rolls back an accepted mutation; integrations retry by
querying `ReconcileMutation` before the documented expiry.

## Server and snapshot requirements

The browser packages and Go room SDK must use the same generated versioned
protocol. Every persisted `SnapshotItem` has an `itemRevision >= 1`. Mutation
receipts and per-session high-water marks are server-private persistence state;
correlated outcome records are private state under the same rule. None are
exposed in the client canvas snapshot. The new protobuf fields and enum values,
Go Config fields, runtime options, and SnapshotRecord fields are additive; old
clients and hosts that do not configure these seams retain their prior behavior.
The superseded anonymous
command protocol is a historical break; future removals require the documented
major-version migration process.

The item studio in `examples/item-playground` is the reference consumer: its
action status follows the matching receipt rather than inferring acceptance
from any increase in the room scene revision.
