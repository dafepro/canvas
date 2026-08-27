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
and `internal`. Consumers own user-facing wording. The optional `message` is a
diagnostic and must not be parsed as a contract.

## Server and snapshot requirements

The browser packages and Go room SDK must use the same generated versioned
protocol. Every persisted `SnapshotItem` has an `itemRevision >= 1`. Mutation
receipts and per-session high-water marks are server-private persistence state;
they are not exposed in the client canvas snapshot. The superseded anonymous
command protocol is a historical break; future removals require the documented
major-version migration process.

The item studio in `examples/item-playground` is the reference consumer: its
action status follows the matching receipt rather than inferring acceptance
from any increase in the room scene revision.
