# Fenced multi-process room ownership

Canvas keeps process-local room ownership by default. A horizontally scaled
host opts into shared ownership by configuring `roomsdk.Config.RoomCoordinator`
and using a shared `roomsdk.Store`. The coordinator decides which server may
run an active room; the store remains the source of canonical durable state.

These deployment concepts are separate:

- Load-balancer affinity routes a participant back to a likely server. It does
  not prevent two servers from owning the same room.
- `RoomCoordinator` grants one expiring lease and a monotonically increasing
  fencing generation. It prevents split-brain authority.
- `Store` holds snapshots, mutation receipts, and reconciliation high-water
  state. Snapshot writes reject an obsolete ownership generation.
- `Authenticator` validates each connection. A routing or room ticket can be
  part of application authentication, but it is not an ownership lease.

Sticky routing alone is therefore insufficient. Every production coordinator
adapter should run `roomsdktest.RunRoomCoordinatorConformance`; every shared
store should run `roomsdktest.RunStoreConformance`. The latter now verifies
that a stale owner cannot overwrite a newer generation even with a numerically
higher checkpoint.

On acquisition, the server loads the highest valid snapshot, writes the new
fence before admitting clients, then renews its lease. Authority-bearing
messages are validated against the current lease. Renewal or validation loss
closes clients with `room_ownership_lost` and deliberately skips a stale final
write. Another server can acquire after expiry and continue from the stored
snapshot without regressing mutation receipts or reconciliation high-water.

`Server.Drain(ctx)` stops new acquisitions, checkpoints each currently owned
room, releases its lease, and waits for completion or the caller's deadline.
The reference `canvasd` invokes it during shutdown. Operators can observe
acquisition, renewal, loss, fencing, and drain counters through the optional
metrics extensions without changing the base `Metrics` interface.
