# Runtime lifecycle and consumer errors

`RoomSession` and `CanvasRuntime` are single-use room instances. Create one when
a product route or lounge mounts, and stop it when that owner unmounts. A later
remount creates a new instance. This keeps terminated workers, renderers,
listeners, and transports from being revived into partially initialized state.

## Lifecycle states

| State | Meaning |
| --- | --- |
| `idle` | Constructed, with no connection attempt. |
| `starting` | Initial transport connection is in progress. |
| `joining` | The transport is open and JOIN has been sent. |
| `active` | JOIN and consumer initialization have completed in a visible page. |
| `backgrounded` | Initialized, but the page is hidden and cannot hold the host lease. |
| `reconnecting` | The transport dropped and is attempting to recover. |
| `stopping` | Teardown or a final normalized checkpoint is in progress. |
| `stopped` | Terminal consumer-requested teardown. |
| `failed` | Terminal startup, transport, protocol, or initialization failure. |

`subscribeLifecycle` immediately replays the current frozen snapshot, then
publishes each transition. Concurrent `start()` calls return the same promise.
`start()` resolves when the transport has opened and JOIN has been sent;
`whenReady()` resolves after JOIN and consumer initialization, including a
`CanvasRuntime` scene mount. `whenPresented()` additionally waits for presence,
a canonical frame, every durable snapshot item, and every connected avatar to
be represented. Use that stronger gate before revealing a staged room. Starting
a stopped or failed instance rejects.

Reconnect is automatic on the same instance. It moves through `reconnecting`
and `joining`, obtains a new ephemeral connection ID, then returns to `active`
or `backgrounded`. Stable participant and avatar IDs do not change.

When the page becomes hidden, Canvas yields an existing host lease and declares
the client ineligible to host. Visibility restoration returns the initialized
instance to `active`. A route unmount calls `stop()`; page exit may call
`stopGracefully()` to give a sole host a bounded opportunity to persist a final
normalized checkpoint. Both stop operations are idempotent and terminal.

## Typed errors

Every application-facing failure is a `CanvasConsumerError` with:

- `code`: stable machine-readable classification;
- `source`: `lifecycle`, `transport`, `protocol`, `initialization`,
  `simulation`, `durable-command`, or `assets`;
- `recoverable`: whether the current room instance can continue;
- `message`: human-readable diagnostic text, not an application contract;
- optional `details` and original `cause`.

Fatal errors reject `start()`, `whenReady()`, or `whenPresented()`, enter `failed`, and release the
worker and transport. Recoverable simulation and durable-command errors are
reported through `onError` without terminating the session. Required asset
preload failures reject `CanvasRuntime.start()` before a room connection opens.

The current stable codes are `invalid_lifecycle_state`, `start_cancelled`,
`transport_connection_failed`, `transport_reconnect_exhausted`,
`transport_closed`, `server_rejected`, `join_initialization_failed`,
`simulation_failed`, `durable_command_rejected`, and `asset_preload_failed`.
Consumers should branch on `code` and `recoverable`, never parse `message`.
