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

The compatible one-call form selects that boundary explicitly:

```ts
await runtime.start({ until: "presented" });
```

`until: "initialized"` composes the original start with `whenReady()`, while
`until: "presented"` composes it with the complete headless presentation gate
and, for `CanvasRuntime`, the first actual renderer update. Omitting `until`
retains the original connection-only timing for existing consumers.

## Startup and presentation progress

Lifecycle answers whether a room connection remains usable. Startup progress
answers what an application is currently waiting for before its first visible,
authoritative frame. `subscribeStartup` immediately replays a frozen
`RuntimeStartupSnapshot` and then publishes monotonic phases:

| Phase | Meaning |
| --- | --- |
| `assets` | Manifest sources are settling. `assets.sources` identifies each required or optional source as `pending`, `loaded`, `warning`, or `failed`. |
| `credentials` | The transport is obtaining fresh room access. |
| `connecting` | The realtime handshake is opening. |
| `joining` | JOIN and consumer initialization are in progress. |
| `simulation` | The current role generation is initializing physics. |
| `canonical` | The session is waiting for generation-consistent presence, durable items, and authoritative entities. |
| `presenting` | A complete draw set is available; a browser runtime is waiting for its first Pixi update. |
| `ready` | The first complete frame was handed to a headless consumer or updated by the browser renderer. |
| `failed` | Startup ended with the snapshot's typed `error`. |
| `cancelled` | `stop()` ended startup before readiness. |

`startupSnapshot` reads the newest value and `whenStartupReady()` waits on the
same state machine. Applications should subscribe before `start()`, display
their own wording, and use `start({ until: "presented" })` before revealing controls.
They do not need to combine asset callbacks, lifecycle states, `whenReady()`,
`whenPresented()`, or an invented timeout.
`formatRuntimeStartupStatus()` supplies optional neutral English labels for all
phases; a product may instead render the semantic snapshot with its own copy.

`ready` is sticky. Reconnect, role migration, backgrounding, and a later stop
do not regress startup or hide an already rendered room. Lifecycle and
authoritative-current diagnostics continue to describe those ongoing events.
Before readiness, stop publishes `cancelled` immediately even if an underlying
asset adapter is still settling its promise.

Each WebSocket opening handshake is bounded to 10 seconds by default. A socket
that closes before opening or exceeds that deadline rejects the current
attempt instead of leaving `start()` pending. Direct transport consumers may
set `connectTimeoutMs`. A terminal startup snapshot gives applications the
typed failure needed to offer a retry with a fresh runtime.

Reconnect is automatic on the same instance. It moves through `reconnecting`
and `joining`, obtains a new ephemeral connection ID, then returns to `active`
or `backgrounded`. Stable participant and avatar IDs do not change.

When the page becomes hidden, Canvas yields an existing host lease and declares
the client ineligible to host. Visibility restoration returns the initialized
instance to `active`. A route unmount calls `stop()`; page exit may call
`stopGracefully()` to give a sole host a bounded opportunity to persist a final
normalized checkpoint. Both stop operations are idempotent and terminal.

## Subscription ownership

Every public runtime subscription accepts an optional `AbortSignal` in
addition to returning its individual unsubscribe function. A route can
therefore own all of its observers with one standard controller:

```ts
const subscriptions = new AbortController();
runtime.subscribePresence(renderRoster, { signal: subscriptions.signal });
runtime.subscribeLifecycle(renderConnection, { signal: subscriptions.signal });
runtime.subscribeOverlayProjection(renderLabels, {
  signal: subscriptions.signal,
  maxHz: 30,
});

// Route unmount
subscriptions.abort();
await runtime.stopGracefully();
```

Aborting before subscription produces no replay and no retained callback.
Observer callbacks are failure-isolated: one throwing observer cannot prevent
later observers, room readiness, transport dispatch, or rendering. The runtime
reports the failure as a recoverable `consumer_callback_failed`; error
observers are themselves isolated to prevent recursive reporting.

## Typed errors

Every application-facing failure is a `CanvasConsumerError` with:

- `code`: stable machine-readable classification;
- `source`: `lifecycle`, `transport`, `protocol`, `initialization`,
  `simulation`, `item-mutation`, `assets`, `input`, or `consumer`;
- `recoverable`: whether the current room instance can continue;
- `message`: human-readable diagnostic text, not an application contract;
- optional `details` and original `cause`.

Fatal errors reject the affected `start()`, `whenReady()`, `whenPresented()`,
or `whenStartupReady()` waiter, enter a terminal state, and release the worker
and transport. Recoverable simulation and item-mutation errors are
reported through `onError` without terminating the session. Required asset
preload failures reject `CanvasRuntime.start()` before a room connection opens.
The non-replaying `subscribeErrors` stream provides the same typed failures for
applications that prefer subscription ownership; `onError` remains supported.

The current stable codes are `invalid_lifecycle_state`, `start_cancelled`,
`transport_connection_failed`, `transport_reconnect_exhausted`,
`transport_closed`, `server_rejected`, `join_initialization_failed`,
`simulation_failed`, `item_mutation_rejected`, `asset_preload_failed`,
`pointer_interaction_failed`, and `consumer_callback_failed`.
Consumers should branch on `code` and `recoverable`, never parse `message`.
