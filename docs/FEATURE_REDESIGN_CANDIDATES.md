# Feature redesign candidates

Internal engineering note, reviewed 2026-08-25 with repository evidence through
`d0331f5`. This is intentionally
separate from `GAPS.md`: it records features whose history suggests that local
fixes have accumulated around a missing state model or transaction boundary.
It is not a promise that every listed feature must be rewritten.

## How a feature gets on this list

A feature is a redesign candidate when at least two of these are true:

- the same user-visible failure returned after more than one focused fix;
- state ownership is spread across unrelated event handlers or timers;
- correctness depends on a timeout instead of an acknowledgement;
- one class coordinates connection, authority, presentation, and persistence;
- tests cover individual fixes but not the complete transition matrix.

Priority 0 changes the structure on which later work is built. Priority 1 is a
major pre-1.0 correctness or public-contract risk. Priority 2 can be isolated
and replaced after 1.0 without changing the core model.

## Completed redesigns

### One pointer interaction coordinator

**Evidence.** Avatar input and item editing install separate pointer listeners.
`CanvasRuntime` arbitrates them through an `allowStart` callback and a duplicate
owned-item hit test. Item editing has separately accumulated tap-versus-drag,
selected-item precedence, overlap selection, capture, and menu-selection fixes
(`1026ddb`, `5744146`, `fc19ac7`, `056dd1f`). The avatar path independently
accumulated capture and out-of-bounds recovery fixes before receiving its own
state machine (`4a9f47c`, `5651d7f`, `651aa28`).

**Implemented.** One runtime-owned `PointerInteractionCoordinator` now owns
each pointer from down through terminal release/cancel. Interaction
strategies—avatar drag, item select, selected-item manipulation, thumbstick,
and consumer gestures—participate through ordered hit tests and explicit
claims. The coordinator, not each feature, owns capture, window tracking,
tap/drag thresholds, cancellation, and diagnostics.

**Verification.** The table-driven coordinator and routing suites cross
priority, overlap, canvas exit/re-entry, capture loss, cancellation, touch,
secondary-pointer rejection, edit and avatar disablement, consumer callback
failure, and immediate re-grab. Every claim receives one and only one terminal
event. The independently running item studio verifies spawn-without-edit and
menu-to-private-controls selection through the public runtime.

Implemented in `93994ed`, `ebd23a2`, `f31b07f`, and `d0331f5`. The public
consumer contract is `POINTER_INTERACTIONS.md`.

## Priority 0

### Split the room-session orchestration state

**Evidence.** `RoomSession` is now responsible for transport lifecycle, JOIN,
host migration, simulation-worker roles, canonical replication, prediction,
durable item commands, edit preview coalescing, presentation readiness,
participant projection, effects, traffic metrics, and graceful sleep. Its
history contains recurring fixes to reconnect/migration, room presentation,
avatar position restore, and peer reconciliation. At more than 1,700 lines,
unrelated transitions still mutate shared booleans, maps, buffers, and timers.

**Redesign.** Keep `RoomSession` as the public facade, but move state into
explicit collaborating machines: `ConnectionSession`, `HostRoleSession`,
`ReplicationTimeline`, `DurableCommandSession`, and `PresentationGate`.
Messages should be reduced through typed transitions with invariants, not
handled as mutations scattered through one switch. Role change and reconnect
must reset or retain each subsystem through a declared policy.

**Acceptance boundary.** Model-based tests generate JOIN/reconnect/host-grant,
late keyframe, checkpoint, background, supersession, and stop transitions. The
test asserts one host role, monotonic epochs/ticks, bounded prediction history,
no post-stop sends, and deterministic readiness/error outcomes.

## Priority 1

### Acknowledged item-edit transactions

**Evidence.** Live item editing now has a local presentation map, coalesced
preview timer, durable commit, canonical transform matching, and a 1.5-second
presentation timeout. Earlier failures included choppy local movement, frozen
state not appearing durable, spawn/edit selection disagreement, and overlap
dragging. The timeout hides an absent or rejected acknowledgement by eventually
dropping the local pose.

**Redesign.** Give each edit an `editSessionId` and each durable mutation a
monotonic `mutationId`. Preview remains disposable and coalesced; commit returns
an explicit accepted transform/revision or typed rejection. The local
presentation ends on that acknowledgement, supersession, or cancellation—not
on elapsed wall time. Freeze, collision, tint/config, transform, and delete use
the same transaction envelope and authorization result.

**Acceptance boundary.** Fault tests cover lost/reordered previews, delayed
commit acknowledgement, rejection, owner disconnect, host migration during an
edit, overlapping selected items, and two tabs attempting the same owned item.

### Startup and presentation progress protocol

**Evidence.** The asset loader itself has a coherent required/optional contract,
but examples repeatedly appeared stuck at messages such as “assets 20/20” or
“arena art 4/4” while the remaining wait was transport or canonical
presentation. Example code manually replaces progress text, and basketball
added its own bounded presentation wait (`2d0c981`). Asset completion,
credential fetch, WebSocket handshake, JOIN, worker initialization, canonical
state, and first render are separate phases but are not one observable progress
protocol.

**Redesign.** Publish a frozen `RuntimeStartupSnapshot` with one discriminated
phase, phase timestamps, terminal typed error, and cancellation. Suggested
phases are `assets`, `credentials`, `connecting`, `joining`, `simulation`,
`canonical`, `presenting`, and `ready`. Required assets report per-source
settlement inside `assets`; reaching N/N advances or fails in the same state
machine. Consumers render status but do not compose readiness promises or
invent timeouts.

**Acceptance boundary.** Conformance tests stall and fail every phase, assert a
terminal outcome, verify stop aborts pending startup, and ensure progress never
regresses after reconnect or role changes.

### Replication and prediction timeline extraction

**Evidence.** Peer rubber-banding recurred around periodic checkpoints and LAN
delay. The current direct-avatar fix correctly records predictions by input
sequence and reconciles against the acknowledged sequence (`57c0421`), but the
history, interpolation buffer, reconciler, tick gate, and canonical publication
still meet inside `RoomSession`.

**Redesign.** Extract a `ReplicationTimeline` that accepts canonical packets,
local input/prediction samples, host epochs, and render time. It owns delta
repair, interpolation/extrapolation, sequence acknowledgement, bounded history,
teleport/reset rules, and diagnostic samples. Rendering asks it for a frame;
session orchestration does not apply presentation correction itself.

**Acceptance boundary.** A deterministic virtual-time matrix varies state Hz,
checkpoint Hz, input Hz, latency, jitter, reordering, loss, host migration, and
edge contact. Invariants include monotonic acknowledged input, no correction
against a future prediction, bounded history, no one-Hz discontinuity, and
eventual canonical convergence.

## Priority 2

### Overlay layout service

**Evidence.** Canvas owns world-to-screen projection, while examples own label
smoothing, arc placement, selected-item controls, and viewport clamping.
Controls have required fixes for clipping outside the canvas and viewport, and
each consumer can repeat the same safe-area and collision-avoidance work.

**Redesign.** Add an optional renderer-independent layout helper over the
existing projection stream: preferred anchors, viewport/safe-area insets,
flip/shift fallback order, and local-only ownership. It must return geometry
only and must not own DOM, styling, or product labels.

**Acceptance boundary.** Geometry tests cover every viewport edge, oversized
content, rotation, fullscreen/orientation resize, and multiple competing
overlays. Consumers remain free to ignore the helper.

### Transient item actions

**Evidence.** Play, restart, or named trigger controls currently have no
owner-authorized transient runtime-to-behavior command, so integrations risk
encoding momentary intent as durable configuration. This gap is already listed
in `GAPS.md`.

**Redesign.** Define one authorized, non-durable action envelope with an action
name, validated payload, request ID, behavior dispatch, and accepted/rejected
result. Actions are never replayed from snapshots and do not mutate item
configuration unless the behavior explicitly emits a durable command through
an existing authority path.

## Reviewed, but not redesign candidates right now

- **Direct avatar edge dragging** accumulated fixes, but now has three explicit
  contracts: pointer ownership, continuous fixed-geometry constraint solving,
  and input-sequence-aware reconciliation. Keep it under the new fault matrix
  before proposing another rewrite.
- **Linked-room travel** accumulated substantial hardening, but it now has a
  documented staged transaction, rollback boundary, identity policy, and
  pre-mortem matrix. Its remaining global-location and multi-process items are
  new infrastructure contracts, not evidence that the navigator should be
  rewritten.
- **Asset loading** is not itself the redesign target. Manifest validation,
  versioning, required/optional failure, and texture creation are cohesive. The
  missing model is startup progress after asset settlement.
- **Fullscreen resizing and motion trails** are presentation features with a
  narrow owner and focused tests. Their recent tuning does not currently show a
  missing authority or lifecycle model.

## Recommended order

1. Decompose `RoomSession` behind its current public facade before expanding
   networking or travel responsibilities.
2. Add acknowledged item mutations and the replication timeline while doing
   that decomposition; both become natural subsystem boundaries.
3. Publish startup progress before asking external consumers to build polished
   loading/error UI.
4. Treat overlay layout and transient item actions as isolated follow-ups.
