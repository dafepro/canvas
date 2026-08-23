# Architecture

This file explains how the pieces fit together. The specification in
`docs/spec.txt` explains why.

## The three layers

```
   browser client                          browser client
+-------------------------+            +-------------------------+
| main thread             |            | main thread             |
|  CanvasRuntime          |            |  CanvasRuntime          |
|   PixiScene             |            |   PixiScene             |
|   PointerDragController |            |  RoomSession            |
|  RoomSession            |            |   InterpolationBuffer   |
|   RoomClient + transport|            |   AvatarReconciler      |
+-----------+-------------+            +-----------+-------------+
            |                                     |
   worker boundary                        worker boundary
            |                                     |
+-----------v-------------+            +-----------v-------------+
| simulation worker       |            | simulation worker       |
|  SimulationKernel       |            |  SimulationKernel       |
|  RapierWorld (all)      |            |  RapierWorld (static +  |
|  BehaviorRuntime        |            |  local avatar only)     |
|  HostSimulation         |            |                         |
+-----------+-------------+            +-----------+-------------+
            |  canonical state, effects, checkpoints             |
            +---------------------+-------------------------------+
                                  |
                        +---------v----------+
                        |  Toxiproxy         |  local only
                        +---------+----------+
                                  |
                        +---------v----------+
                        |  canvasd           |
                        |   roomsdk.Server   |
                        |   host lease        |
                        |   ownership         |
                        |   relay             |
                        |   snapshot store    |
                        +--------------------+
```

## Who owns what

| Concern | Owner |
| --- | --- |
| Stepping physics | The simulation host client, in its worker |
| Running item behaviors | The simulation host client |
| Normalizing behavior state for room sleep | The last simulation host client |
| Predicting the local avatar | Every client |
| Rendering | Every client, main thread |
| Granting the host lease | The Go server |
| Validating an owner edit | The Go server |
| Storing a checkpoint | The Go server |
| Relaying realtime packets | The Go server, in V1 |

## The behavior boundary

This is the most important extensibility decision. A behavior is a pure
function of `(context, config, state, event)` returning `{ state, commands }`.
It cannot reach PixiJS, the transport, or persistence.

```
physics step  ->  normalized events  ->  behavior.onEvent  ->  commands
                        ^                                          |
                        |                                          v
                  contacts, regions,                      BehaviorHost applies
                  timers, ticks                           them to the world
```

Two rules make a host reproducible and a behavior testable:

1. Events run in a fixed order inside one tick. See `eventOrder` in
   `packages/core/src/behavior/events.ts`.
2. Commands are applied only after every handler for the tick has run. A
   handler therefore never sees a world half-changed by another handler.

`BehaviorHost` is the only interface between a behavior and the world.
`RapierWorld` implements it for real physics; `BehaviorTestHost` implements it
with plain objects, so a behavior test needs no engine and no browser.

When a snapshot carries an older `behaviorStateVersion`, `BehaviorRuntime`
applies the behavior's `MigrationChain` before the state is attached. The
resulting checkpoint records the migrated behavior version and the item's real
definition version; neither value is inferred from a global schema constant.

## Forces are one-tick impulses

Rapier keeps a force added with `addForce` until the force is reset. Applying
gravity that way accumulates it across ticks. `RapierWorld` therefore converts
every per-tick force into an impulse of `force * mass * dt`. `applyForce` in a
behavior means "apply this force for one tick".

## The environment field

Canvas physics is not one global gravity vector. `EnvironmentField.sample`
returns gravity, drag, a soft speed limit, friction, and the elevation channel
for one point. Region modifiers blend in by priority. This is why the rocket
needs no special gravity code: the canvas supplies a gradient that reduces
gravity and raises drag with height.

A soft speed limit adds drag only to the velocity above the threshold. It never
clamps, so motion stays smooth across the network.

## Host lease and epoch fencing

Every canonical packet carries `host_epoch`. The server increments the epoch
before it grants a lease. A client drops any state packet whose epoch is not the
one it knows, so an old host that reconnects cannot publish. The server refuses
state and checkpoints from a client without the active lease.

The heartbeat is the real health signal. A visibility event is a hint, because a
crashed tab sends no event.

An active host migration resumes the checkpoint tick and checkpointed behavior
state without emitting `room.wake`. The promoted peer seeds avatars from the
last canonical keyframe/delta positions it received. Periodic active checkpoints
carry behavior timers as elapsed and remaining ticks, allowing a replacement
host to rebuild them against the resumed canonical tick. A true sleeping-room
wake is marked separately, contains no active timers, and emits `room.wake` so
transient workflows reset.

## Durable versus canonical

Two different kinds of authority, easy to confuse:

- **Canonical simulation** is the host's. It decides where a body is this tick.
- **Durable ownership** is the server's. It decides whether an owner may move,
  configure, or delete an item.

A host that lies about physics cannot grant itself edit rights. The server sets
`ownerUserId` from the authenticated session, never from the client payload.

## Room-sleep normalization

Only the simulation host has the behavior implementations and timer state, so
only it can normalize a snapshot for sleep. A graceful last host asks its worker
to normalize behavior state, zero motion, and send a final checkpoint before it
closes. The server validates that the checkpoint's `final` flag agrees with the
snapshot's `normalized` marker and preserves that marker when the room sleeps.

After an abrupt host loss, the server sleeps the room from the newest periodic
checkpoint. It does not claim that developer-authored behavior normalization
ran. Snapshots contain no velocity, so wake still rebuilds bodies with zero
motion; the false marker records that abrupt fallback accurately.

The reference `canvasd` keeps definitions in their source JSON files and stores
canonical `SnapshotRecord` values in `FileStore`. Each save writes a new atomic,
version-named JSON file and retains a previous version for recovery. The CLI
reloads the newest valid record from `CANVASD_DATA_DIR` after a process restart.

## Realtime transform encoding

`EntityState` carries one fixed-point `QuantizedTransform`. Position, elevation,
and linear velocity are signed integers at 1/100-unit precision. Rotation and
angular velocity are signed integers at 1/1000-radian precision. This keeps the
host's 15 Hz deltas compact while keeping maximum round-trip error at 0.005
canvas units and 0.0005 radians.

The wire protocol is prerelease: superseded transform fields are removed rather
than decoded through a compatibility branch. The server rejects canonical state
without the current transform message.

## Rates

| Loop | Rate | Set in |
| --- | --- | --- |
| Physics and behavior tick | 60 Hz fixed | `HostSimulation` |
| Render | Up to 60 FPS | Pixi ticker |
| Input to the host | 30 Hz | `RoomSession` |
| Host state delta | 15 Hz | `RoomSession` |
| Host keyframe | 2 Hz | `RoomSession` |
| Checkpoint to the server | 1 Hz | `RoomSession` |
| Owner edit preview | Up to 15 Hz, coalesced | `RoomSession` |
| Host heartbeat | 2 Hz | `RoomClient` |

## Extending the system

| Goal | Where to work |
| --- | --- |
| A new interactive item | Register an `ItemBehavior`, then add an `ItemDefinition`. Touch no protocol code. |
| A new canvas | Write a `CanvasDefinition` and export it with `make export-canvases`. |
| A different transport | Implement `RoomTransport`, then run `runRoomTransportConformance` from `@canvas-physics/client/testing`. Nothing in the runtime or behaviors changes. |
| A real database | Implement `roomsdk.Store`. |
| A real session check | Implement `roomsdk.Authenticator`. |
| A new wire field | Edit `room.proto`, then run `make generate`. |
| A headless client in a test | Build a `RoomSession` with `SimulationDriver.local()`. It needs no DOM. |
