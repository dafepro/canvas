# Feature redesign candidates

Internal engineering note, reviewed 2026-08-25 with repository evidence through
`f67c07b`. This is intentionally
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
avatar position restore, and peer reconciliation. At 1,932 lines,
unrelated transitions still mutate shared booleans, maps, buffers, and timers.

The inventory found one additional race boundary: simulation responses are not
tagged with the worker/role generation that produced them. A delayed `ready`,
`render`, `effects`, or `snapshot` response can therefore arrive after a host
promotion, demotion, reconnect, or stop and be interpreted as current. The
`render.isHost` value exists but is not a sufficient fence and is currently not
used by `RoomSession` when accepting the frame.

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

#### Scope and non-goals

This is an ownership and transition redesign, not a new networking algorithm.
`RoomSession` remains the intentional public facade because consumers need one
room handle; the implementation behind it is replaced, not wrapped in legacy
adapters. Its existing start/stop, mutation, observation, diagnostics, and draw
surface remains stable unless a characterization test proves the contract is
internally contradictory. Any superseded internal type or path is deleted in
the same verified slice that replaces it.

This work creates the boundaries needed by three later candidates but does not
silently implement them:

- `DurableCommandSession` initially preserves the current command protocol and
  preview semantics. Explicit mutation acknowledgements remain the next item-
  transaction change.
- `ReplicationTimeline` initially preserves the current interpolation and
  reconciliation algorithms. The larger latency/jitter algorithm matrix
  remains replication hardening after extraction.
- `PresentationGate` initially preserves `whenReady()` and `whenPresented()`.
  A public multi-phase startup progress stream remains its own contract.

No subsystem may import Pixi, the DOM-facing runtime, or a consumer package.
No new internal module is exported merely because it was extracted.

#### Target ownership

`RoomSession` routes external events and executes typed effects. It does not
hold duplicated subsystem state or decide transitions itself.

| Owner | State it exclusively owns | Inputs | Effects/outputs |
| --- | --- | --- | --- |
| `ConnectionSession` | Single-use lifecycle, connection/join generation, page visibility, terminal error, ready waiters, and resource-close state | Public start/stop/visibility, transport status, JOIN initialization result, server error | Connect/close transport, host eligibility/yield requests, lifecycle snapshots, waiter settlement |
| `HostRoleSession` | Current role, host epoch/generation, migration counters, simulation readiness for that generation, host entity source, host avatar membership, active host publishing/checkpoint schedules, and graceful-final-checkpoint transaction | JOIN initialized, host granted/changed, participant changes, simulation responses, scheduled host sends, graceful stop | Generation-tagged worker role/init/avatar messages, canonical state/effect/checkpoint sends, host diagnostics |
| `ParticipantRoster` | Stable participant tombstones, ephemeral connections, active/inactive/disconnected state, last canonical avatar positions, and applied projection state | Presence, avatar canonical state, player input state, JOIN snapshot | Frozen presence snapshot and host avatar add/lifecycle intents |
| `ReplicationTimeline` | Host epoch/tick gate, interpolation buffer, local prediction, acknowledged input sequence, bounded prediction history, reconciliation, canonical/behavior snapshots, and host delta/keyframe baselines | Full state, delta, authoritative host frame, local prediction frame, render time, epoch reset | Draw frame, frozen observer snapshots, encoded changed/removed entities, replication diagnostics |
| `DurableCommandSession` | Command identity, item metadata, preview coalescing schedule, pending preview, rejection state, and current item count | Public mutation, JOIN metadata, accepted/rejected/preview result, connection generation change | Reliable commands and typed worker item mutations |
| `PresentationGate` | Readiness facts and sticky public presentation outcome for the current room session | JOIN initialized, simulation generation ready, roster snapshot, canonical entity IDs, terminal failure | Resolve/reject `whenPresented`, internal authoritative-current diagnostics |

Frozen canonical, behavior, presence, lifecycle, and effect observers remain
facade-level public ports, but the values come from the sole owner above. A
small internal `SessionClock` port supplies interval/timeout registration so
each owner can cancel only its own work and pure tests can use virtual time.

`RoomClient` is narrowed during slice 0 so it cannot remain a competing source
of session truth. It keeps transport ownership, protobuf encode/decode,
heartbeat IO, traffic counters, and the minimum ingress epoch fence needed to
drop invalid wire packets. JOIN, host control, and durable acceptance publish
immutable versioned tokens (`ConnectionIdentity`, `HostLease`, and
`DurableRevision`) instead of exposing mutable `clientId`, `isHost`,
`hostEpoch`, or `sceneRevision` fields. The appropriate subsystem retains the
latest token as its semantic state. Outbound effects carry the token they were
created under, and `RoomClient` drops an effect whose token is no longer
current. This preserves defense-in-depth without two independently mutable
role models.

Subsystems communicate with typed events and effects rather than mutating each
other. Each reducer has the form
`reduce(state, event) -> { state, effects }`; only `RoomSession` may execute an
effect against `RoomClient`, `SimulationDriver`, the clock, or a consumer
observer. Reducers must not call each other recursively. Follow-up events from
an executed effect return through the same dispatch queue, which makes ordering
visible and prevents half-applied transitions.

#### Generation and epoch rules

Generation fencing is the first implementation slice because every extraction
depends on it.

- The connection generation increases on every transport-open/JOIN attempt.
  An async initialization completion is accepted only for the generation that
  requested it.
- The simulation generation increases on initial worker setup and every host
  role rebuild. `init` and `setHost` carry it; every worker response echoes it.
  A response from any other generation is ignored and counted diagnostically.
- Host epoch never decreases. A grant/change for an older epoch is ignored and
  reported as an invariant violation. There is at most one active host role
  and one set of host publishing timers for an epoch.
- Canonical tick is monotonic within one host epoch. An epoch reset may seed
  from its checkpoint tick; packets from the previous epoch cannot enter the
  new interpolation or prediction history.
- Stop/failure advances the terminal generation before resources close. Late
  transport, clock, worker, or consumer-initialization callbacks may produce no
  sends, observer publications, or waiter resolutions.

These are internal prerelease contracts. The old untagged worker messages are
removed when tagging lands; there is no dual decoder.

#### Declared transition policy

| Transition | Reset | Retain |
| --- | --- | --- |
| Reconnect before JOIN | Host role and its timers; unconfirmed preview; connection-scoped worker effects | Stable participant/avatar identity, last displayed canonical frame, public observers and unresolved readiness waiters |
| Rejoined as the same participant | Ephemeral client ID, connection generation, host eligibility from current visibility | Stable avatar ID and latest validated avatar position; do not remove/re-add the same local avatar without a role rebuild |
| Host grant/promotion | Interpolation correction, prediction history, delta/behavior baselines, applied host-avatar projection, simulation generation | Newest already-observed avatar positions over an older checkpoint; durable item metadata reconciled with accepted snapshot |
| Host loss/demotion | Host send/checkpoint schedules, final-checkpoint transaction, host entity source, simulation generation | Local avatar identity and a peer prediction seeded from the newest validated position |
| Background | Host eligibility and, if hosting, lease ownership | Session identity, presentation, observers, and peer prediction; exactly one yield is emitted for the transition |
| Durable rejection | Only the matching pending mutation/preview state | Canonical item metadata and unrelated commands; publish one recoverable typed error |
| Terminal server rejection, stop, or failed initialization | Every timer, pending effect, role, prediction, preview, and waiter | Terminal lifecycle/error snapshot only; driver and client close exactly once |

After the room has once reached public `presented`, reconnect does not hide the
already displayed room or make that promise regress. The gate separately tracks
whether the current connection generation has a complete authoritative frame.
A reconnect before first presentation discards the stale generation's facts but
keeps the original waiter pending for the new generation.

#### Implementation slices

Each numbered slice is a separately committed vertical change. It begins with
the listed failing/characterization tests and ends by deleting the state and
methods it replaced from `RoomSession`.

0. **Characterize the facade and add generation fences.** Build an internal
   deterministic harness with a fake `RoomClient` port, fake
   `SimulationDriver`, and virtual `SessionClock`. Record normalized public
   traces for first join, reconnect before/after readiness, promotion,
   demotion, background/foreground, supersession, graceful stop, and stop while
   initialization is pending. Add `connectionGeneration` and
   `simulationGeneration` to the internal main-thread/worker contract and tests
   proving delayed old-generation `ready`, `render`, `effects`, `snapshot`, and
   initialization completions are inert. Replace mutable `RoomClient` authority
   fields with the immutable versioned tokens described above; do not retain a
   property-based compatibility surface.
1. **Extract `DurableCommandSession`.** Move command construction, IDs, item
   metadata, preview coalescing, accepted-command translation, rejection, and
   item counts. Test preview timing with virtual time, reconnect cancellation,
   rejection isolation, and accepted results while host/peer. Delete all
   preview timers, command counters, and metadata maps from the facade.
2. **Extract `ReplicationTimeline`.** Move packet decoding, epoch/tick gates,
   interpolation, prediction history, reconciliation, canonical/behavior
   snapshots, host change detection, and delta/keyframe baselines. Port the
   current direct-drag acknowledgement and one-Hz checkpoint regression tests
   to deterministic time. Delete buffers, reconcilers, prediction maps,
   `lastSent`, and behavior-byte tracking from the facade.
3. **Extract `ParticipantRoster` and `PresentationGate`.** Move presence
   tombstones, inactive/disconnected projection, validated avatar positions,
   readiness facts, and waiter outcomes. Cross JOIN/simulation/presence/
   canonical arrival in every order, including missing template items and a
   reconnect on each boundary. Delete participant maps, saved-position maps,
   presentation booleans, and presentation waiters from the facade.
4. **Extract `HostRoleSession`.** Move promotion/demotion, generation-tagged
   worker role changes, avatar synchronization, incoming peer input, host
   delta/keyframe/effect/checkpoint schedules, migration diagnostics, and the
   graceful final checkpoint. Test late old-host frames, rapid
   grant-change-grant sequences, hidden promotion refusal, stale checkpoint
   response, and stop during final-checkpoint wait. Delete host flags, host
   entity storage, host timers, avatar sets, and final-checkpoint callbacks
   from the facade.
5. **Extract `ConnectionSession` and collapse the facade.** Move start,
   reconnect, JOIN initialization, lifecycle transitions, visibility,
   terminal failure, teardown, and ready waiters. `RoomSession` becomes public
   API delegation plus one queued event/effect router. Prove public traces from
   slice 0 remain identical and that no subsystem can send after terminal
   transition.
6. **Run the cross-product and real-relay gates.** Exercise the bounded model,
   then the existing reconnect, migration, packet loss/reordering, late join,
   graceful sleep, linked-room, basketball, and load-budget cases. Pack the
   client and build the external reference consumers. Remove the temporary
   normalized trace fixtures if the invariant/model tests fully supersede
   them; do not leave two test authorities.

#### Verification model

The pure-machine suite uses a bounded event-sequence generator rather than
wall-clock sleeps. It generates valid and deliberately invalid combinations of
transport status, JOIN generations, host epochs, worker generations, canonical
ticks, visibility, preview timers, and stop. A small reference model compares
the observable lifecycle, role, readiness, sends, and terminal effects after
every event. A failing case prints its seed and minimal event trace.

Invariants checked after every event:

- lifecycle and public readiness never regress outside the documented
  reconnect path;
- at most one role, host schedule set, preview timer, and final-checkpoint
  transaction is active;
- host epoch, canonical tick within an epoch, acknowledged input sequence, and
  durable command identity are monotonic;
- prediction history stays bounded and never reconciles canonical sequence N
  against a prediction newer than N;
- participant identity maps to exactly one avatar and a disconnected
  participant cannot become active without a new authenticated presence entry;
- presentation resolves only when the same generation has simulation
  readiness, current presence, and every authoritative item/avatar;
- terminal state closes resources once, settles every waiter once, and emits no
  later send or observer notification;
- every externally visible failure is a typed `CanvasConsumerError` with a
  stable source and code.

The real-process tier remains necessary for transport ordering and server
authority. It must include duplicate-session supersession, reconnect under
latency/reordering, moving and timer-driven host migration, background yield,
periodic checkpoint crossing, graceful final sleep, durable edit during role
change, and late join. Physical-device profiling is not a blocker for this
structural redesign.

#### Completion boundary

The redesign is complete when `RoomSession` owns no domain timer, interpolation
buffer, prediction map, participant map, item metadata, host entity array, or
role boolean; it delegates the existing public API to the sole owners above.
Subsystem dependencies are acyclic and IO is executed only by the facade's
effect runner. All generation/epoch invariants, focused suites, real-relay
gates, packed artifacts, and reference builds pass. The completed section then
records the implementation commits, and the Priority 1 transaction/timeline/
startup candidates are updated to describe only the remaining algorithm or
public-contract work.

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
