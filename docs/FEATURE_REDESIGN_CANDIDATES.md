# Feature redesign candidates

Internal engineering note, reviewed 2026-08-25 with repository evidence through
`f85bfc9`. This is intentionally
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

### Room-session state ownership

**Implemented.** `RoomSession` remains the public room handle and IO effect
runner, while six internal owners now hold the state that previously crossed
unrelated callbacks: `ConnectionSession`, `HostRoleSession`,
`ReplicationTimeline`, `DurableCommandSession`, `ParticipantRoster`, and
`PresentationGate`. Worker requests and responses are fenced by simulation
generation. Connection/JOIN work is fenced by connection generation. Host-only
schedules and graceful checkpoint settlement belong to the current immutable
host lease. `RoomClient` publishes frozen connection, lease, and durable-
revision tokens instead of independently writable authority fields.

`RoomSession` fell from 1,932 to 1,038 lines. It owns no domain timer, role or
lifecycle boolean, prediction/interpolation buffer, participant map, durable
metadata map, host avatar set, or final-checkpoint callback.

**Verification.** Direct machine tests cover preview timing, replication,
participant projection, presentation arrival order, rapid host transitions,
stale worker generations, final checkpoint timeout, initialization races,
terminal scheduling, and every bounded five-event connection trace. The full
client gate passes 199 tests, including duplicate-session supersession, all
packet-loss/reordering cases, migration, graceful sleep, and the 20-client load
budget. Packed external consumers and all four reference builds pass.

Implemented in `76c1bb8`, `7c8aa9d`, `ec3cc0b`, `6d6fdfb`, `b18bf1d`,
`cbb9e0b`, and `f85bfc9`.

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

## Completed design record

### Room-session state decomposition

**Original evidence.** `RoomSession` was responsible for transport lifecycle, JOIN,
host migration, simulation-worker roles, canonical replication, prediction,
durable item commands, edit preview coalescing, presentation readiness,
participant projection, effects, traffic metrics, and graceful sleep. Its
history contains recurring fixes to reconnect/migration, room presentation,
avatar position restore, and peer reconciliation. At 1,932 lines,
unrelated transitions still mutate shared booleans, maps, buffers, and timers.

The inventory found one additional race boundary: simulation responses were not
tagged with the worker/role generation that produced them. A delayed `ready`,
`render`, `effects`, or `snapshot` response could therefore arrive after a host
promotion, demotion, reconnect, or stop and be interpreted as current. The
`render.isHost` value existed but was not a sufficient fence and was not used
by `RoomSession` when accepting the frame.

**Implemented design.** Keep `RoomSession` as the public facade, but move state into
explicit collaborating machines: `ConnectionSession`, `HostRoleSession`,
`ReplicationTimeline`, `DurableCommandSession`, and `PresentationGate`.
Messages should be reduced through typed transitions with invariants, not
handled as mutations scattered through one switch. Role change and reconnect
must reset or retain each subsystem through a declared policy.

**Verified boundary.** Deterministic and real-relay tests cross JOIN/reconnect/host-grant,
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
| `HostRoleSession` | Current immutable lease, host epoch/generation, migration counters, simulation readiness for that generation, host avatar membership, active host publishing/checkpoint schedules, and graceful-final-checkpoint transaction | JOIN initialized, host granted/changed, participant changes, simulation responses, scheduled host sends, graceful stop | Generation-tagged worker role/init/avatar messages, canonical state/effect/checkpoint sends, host diagnostics |
| `ParticipantRoster` | Stable participant tombstones, ephemeral connections, active/inactive/disconnected state, last canonical avatar positions, and applied projection state | Presence, avatar canonical state, player input state, JOIN snapshot | Frozen presence snapshot and host avatar add/lifecycle intents |
| `ReplicationTimeline` | Host entity source, host epoch/tick gate, interpolation buffer, local prediction, acknowledged input sequence, bounded prediction history, reconciliation, canonical/behavior snapshots, and host delta/keyframe baselines | Full state, delta, authoritative host frame, local prediction frame, render time, epoch reset | Draw frame, frozen observer snapshots, encoded changed/removed entities, replication diagnostics |
| `DurableCommandSession` | Command identity, item metadata, preview coalescing schedule, pending preview, rejection state, and current item count | Public mutation, JOIN metadata, accepted/rejected/preview result, connection generation change | Reliable commands and typed worker item mutations |
| `PresentationGate` | Readiness facts and sticky public presentation outcome for the current room session | JOIN initialized, simulation generation ready, roster snapshot, canonical entity IDs, terminal failure | Resolve/reject `whenPresented`, internal authoritative-current diagnostics |

Frozen canonical, behavior, presence, lifecycle, and effect observers remain
facade-level public ports, but the values come from the sole owner above. A
small internal `SessionClock` port supplies interval/timeout registration so
each owner can cancel only its own work and pure tests can use virtual time.

`RoomClient` was narrowed during the redesign so it cannot remain a competing source
of session truth. It keeps transport ownership, protobuf encode/decode,
heartbeat IO, traffic counters, and the minimum ingress epoch fence needed to
drop invalid wire packets. JOIN, host control, and durable acceptance publish
immutable versioned tokens (`ConnectionIdentity`, `HostLease`, and
`DurableRevision`) instead of exposing mutable `clientId`, `isHost`,
`hostEpoch`, or `sceneRevision` fields. The appropriate subsystem retains the
latest token as its semantic state. Host-authority effects carry the lease they
were created under, and `RoomClient` drops one whose lease is no longer current.
This preserves defense-in-depth without two independently mutable role models.

Subsystems communicate through typed events, effects, and immutable snapshots
rather than mutating each other's state. `RoomSession` executes effects against
`RoomClient` and `SimulationDriver`; each owner alone mutates its semantic
state. Transition tests observe emitted effects so ordering remains explicit.

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

#### Implementation slices (completed)

Each numbered slice was committed as a verified vertical change and deleted the
state and methods it replaced from `RoomSession`.

0. **Characterize the facade and add generation fences (`76c1bb8`).** Build an internal
   deterministic harness with a fake `RoomClient` port, fake
   `SimulationDriver`, and virtual `SessionClock`. Record normalized public
   traces for first join, reconnect before/after readiness, promotion,
   demotion, background/foreground, supersession, graceful stop, and stop while
   initialization is pending. Add `connectionGeneration` and
   `simulationGeneration` to the internal main-thread/worker contract and tests
   proving delayed old-generation `ready`, `render`, `effects`, `snapshot`, and
   initialization completions are inert.
1. **Extract `DurableCommandSession` (`7c8aa9d`).** Move command construction, IDs, item
   metadata, preview coalescing, accepted-command translation, rejection, and
   item counts. Test preview timing with virtual time, reconnect cancellation,
   rejection isolation, and accepted results while host/peer. Delete all
   preview timers, command counters, and metadata maps from the facade.
2. **Extract `ReplicationTimeline` (`ec3cc0b`).** Move packet decoding, epoch/tick gates,
   interpolation, prediction history, reconciliation, canonical/behavior
   snapshots, host change detection, and delta/keyframe baselines. Port the
   current direct-drag acknowledgement and one-Hz checkpoint regression tests
   to deterministic time. Delete buffers, reconcilers, prediction maps,
   `lastSent`, and behavior-byte tracking from the facade.
3. **Extract `ParticipantRoster` and `PresentationGate` (`6d6fdfb`).** Move presence
   tombstones, inactive/disconnected projection, validated avatar positions,
   readiness facts, and waiter outcomes. Cross JOIN/simulation/presence/
   canonical arrival in every order, including missing template items and a
   reconnect on each boundary. Delete participant maps, saved-position maps,
   presentation booleans, and presentation waiters from the facade.
4. **Extract `HostRoleSession` (`b18bf1d`).** Move promotion/demotion, generation-tagged
   worker role changes, avatar synchronization, incoming peer input, host
   delta/keyframe/effect/checkpoint schedules, migration diagnostics, and the
   graceful final checkpoint. Test late old-host frames, rapid
   grant-change-grant sequences, hidden promotion refusal, stale checkpoint
   response, and stop during final-checkpoint wait. Delete host flags, host
   entity storage, host timers, avatar sets, and final-checkpoint callbacks
   from the facade.
5. **Extract `ConnectionSession` and collapse the facade (`cbb9e0b`).** Move start,
   reconnect, JOIN initialization, lifecycle transitions, visibility,
   terminal failure, teardown, and ready waiters. `RoomSession` becomes public
   API delegation plus typed effect execution. Prove public traces from
   slice 0 remain identical and that no subsystem can send after terminal
   transition.
6. **Narrow room authority and run the release gates (`f85bfc9`).** Replace
   mutable `RoomClient` authority fields with immutable versioned tokens and no
   property-based compatibility surface. Exercise the bounded model, then the
   existing reconnect, migration, packet loss/reordering, late join,
   graceful sleep, linked-room, basketball, and load-budget cases. Pack the
   client and build the external reference consumers. Remove the temporary
   normalized trace fixtures if the invariant/model tests fully supersede
   them; do not leave two test authorities.

#### Verification model

The machine suite uses virtual clocks and a bounded five-event connection
sequence generator rather than wall-clock sleeps. Focused state-machine tables
cross host epochs, worker generations, visibility, preview timers, canonical
arrival orders, and stop. Real-process tests supply the transport ordering and
multi-client cross-product that pure owners intentionally do not simulate.

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

The redesign is complete because `RoomSession` owns no domain timer, interpolation
buffer, prediction map, participant map, item metadata, host entity array, or
role boolean; it delegates the existing public API to the sole owners above.
Subsystem dependencies are acyclic and IO is executed only by the facade's
effect runner. All generation/epoch invariants, focused suites, real-relay
gates, packed artifacts, and reference builds pass. Priority 1 below now
describes only remaining algorithm and public-contract work.

## Priority 0

No Priority 0 redesign remains open. New work should not add state back to the
facade or reintroduce writable room-authority fields.

## Priority 1

### Acknowledged item-edit transactions

**Status:** implementation-ready plan; this is the next redesign slice.

#### Evidence and current failure modes

Live item editing currently crosses four owners without carrying one operation
identity through them:

- `ItemEditInteraction` emits anonymous preview and commit callbacks.
- `DurableCommandSession` owns one global coalesced preview timer and constructs
  `commandId`, but its public mutation methods return `void` and rejection is an
  uncorrelated string.
- The relay echoes `commandId` in `DurableCommandResult`, yet the client reduces
  the message to generic accepted/rejected events. It does not retain an
  in-flight mutation or protect the server from applying a retried command
  twice.
- `ItemEditPresentation` holds a committed local transform until canonical
  state happens to match it or 1.5 seconds pass. A timeout therefore makes a
  missing result, a rejected command, and slow canonical presentation look the
  same.

This has already surfaced as choppy local movement, frozen state not appearing
durable, spawn/edit selection disagreement, overlap dragging, and example code
that treats *any* scene-revision increase as acceptance of its latest edit. The
current global preview slot also lets a preview for one item replace a queued
preview for another.

#### Design decisions

1. **Separate edit sessions, previews, and durable mutations.** An edit session
   is the bounded lifetime in which one client is presenting controls for one
   item. Previews are disposable pose samples within that session. A mutation
   is a reliable, server-authorized state change with exactly one terminal
   outcome.
2. **Keep the server authoritative.** Local presentation is immediate, but it
   is never evidence that a mutation succeeded. The accepted result carries
   the authoritative item (or deletion tombstone), item revision, and room
   scene revision.
3. **Use per-item concurrency, not the room scene revision.** Every accepted
   item mutation increments `itemRevision`. A mutation submits the item
   revision it was based on, so unrelated items can change concurrently while
   stale edits to the same item receive a typed conflict.
4. **Permit only one live preview session per item.** Beginning an edit obtains
   a short server lease scoped to the authenticated user, logical client
   session, edit session, and entity. The accepted result advertises its lease
   duration and the client renews it while the controls remain open. A second
   tab can still view the item, but its edit request receives
   `item_edit_in_use` until the lease is released, disconnected, or expires.
   This prevents two preview streams from making the host alternate poses. The
   lease is an editing arbitration tool, not an ownership or persistence lock.
5. **Serialize durable writes per item.** The client may present subsequent
   button presses or drags immediately, but it sends the next mutation for an
   item only after the preceding result supplies the new `itemRevision`.
   Mutations for different items remain parallel.
6. **Make reconnect retry idempotent.** A logical client-session ID survives
   socket reconnects, and mutation IDs are monotonic within it. The server
   persists a bounded receipt ledger keyed by authenticated user, logical
   client session, and mutation ID. A duplicate returns the stored result and
   never reapplies the mutation. A duplicate older than the retained window is
   rejected as `mutation_receipt_expired`; it is never guessed or reapplied.
7. **Replace the prerelease contract in place.** The `preview` boolean command,
   anonymous rejection callbacks, and timeout fallback are removed. There is no
   compatibility decoder, overload, or parallel protocol path.

#### Public contract

The runtime exposes one discriminated mutation request and keeps convenience
methods as thin, typed wrappers:

```ts
type ItemMutationRequest =
  | { kind: "spawn"; definitionId: string; transform: Transform }
  | { kind: "transform"; entityId: string; transform: Transform }
  | { kind: "config"; entityId: string; config: unknown }
  | { kind: "isolation"; entityId: string; isolated: boolean }
  | { kind: "collisions"; entityId: string; enabled: boolean }
  | { kind: "delete"; entityId: string };

interface ItemMutationReceipt {
  readonly clientSessionId: string;
  readonly mutationId: number;
  readonly editSessionId?: string;
  readonly settled: Promise<ItemMutationOutcome>;
}

type ItemMutationOutcome =
  | {
      status: "accepted";
      mutationId: number;
      sceneRevision: number;
      itemRevision: number;
      item?: SnapshotItem;
      deletedEntityId?: string;
    }
  | {
      status: "rejected";
      mutationId: number;
      code: ItemMutationRejectCode;
      message?: string;
      authoritativeItem?: SnapshotItem;
    }
  | {
      status: "cancelled" | "superseded";
      mutationId: number;
      reason: string;
    };
```

`spawnItem`, `moveItem`, `rotateItem`, `scaleItem`, `setItemConfig`,
`setItemIsolation`, `setItemCollisionsEnabled`, and `deleteItem` return an
`ItemMutationReceipt`; they no longer return `void`. Expected authorization or
validation failures settle that receipt and publish a frozen mutation observer
snapshot. They do not masquerade as transport errors through `onError`.

Interactive editing additionally uses a handle equivalent to:

```ts
interface ItemEditHandle {
  readonly editSessionId: string;
  readonly entityId: string;
  readonly state: "opening" | "active" | "ending" | "ended";
  preview(transform: Transform): void;
  mutate(request: ItemMutationRequest): ItemMutationReceipt;
  end(): void;
  cancel(): void;
}
```

Selection and controls may appear optimistically while the edit lease opens,
but network previews wait for the accepted begin result. Lease rejection ends
the optimistic presentation and exposes the typed reason to the consumer.
Finishing the UI ends the edit session but does not discard mutation receipts
that are still awaiting their terminal result.

#### Wire and persistence contract

The current `DurableCommand.preview` shape is replaced by three explicit
families:

- Reliable `BeginItemEdit` / `ItemEditSessionResult` / `RenewItemEdit` /
  `EndItemEdit` messages establish, renew, and release the edit lease. They
  carry `clientSessionId`, `editSessionId`, `entityId`, and the observed
  `itemRevision`; accepted begin/renew results include the authoritative lease
  expiry.
- Disposable `ItemEditPreview` messages carry `editSessionId`, `entityId`, a
  monotonic `previewSequence`, and a transform. The relay and host ignore
  unknown sessions and non-increasing sequences. The latest preview is retained
  only long enough to replay to a newly elected host.
- Reliable `ItemMutation` / `ItemMutationResult` messages carry
  `clientSessionId`, `mutationId`, optional `editSessionId`, the expected item
  revision, and a typed mutation union. Accepted results broadcast the
  authoritative item or deletion tombstone; rejected results return only to
  the requester with a stable enum code and optional diagnostic message.

`SnapshotItem` gains `itemRevision`. The persisted room snapshot also stores a
bounded mutation-receipt ledger and its per-client high-water marks so an
accepted mutation cannot be duplicated after a relay restart. Because the
project is prerelease, existing fixtures and generated TypeScript/Go protocol
code move directly to the new shape; old snapshots and command envelopes are
not migrated or decoded.

Stable rejection codes cover at least malformed payload, not found,
system-owned, not owner, edit in use, edit expired, stale item revision, bounds,
scale, definition/config validation, capacity, receipt expired, and internal
failure. Product text remains consumer-owned.

#### Ownership and state transitions

| Concern | Sole owner | Rule |
| --- | --- | --- |
| IDs, per-item send queues, pending receipts | `DurableCommandSession` | A receipt reaches one terminal state exactly once. |
| Edit lease and preview sequence | Relay room | One active edit session per entity; cleanup always emits an authoritative revert to the host. |
| Authorization, item revision, deduplication | Relay room | Validate and record a receipt before broadcasting one accepted result. |
| Optimistic transform/config presentation | New transaction presentation helper owned by `DurableCommandSession` | Never expires on wall time; it transitions only from mutation/edit events and canonical evidence. |
| Pointer gesture interpretation | `ItemEditInteraction` | Produces intent for an existing edit handle; owns no network timer or mutation result. |
| Canonical physics application | Current host simulation | Applies only authoritative accepted mutations or validated previews fenced by host epoch. |
| UI status and wording | Consumer | Observes handles/receipts; never infers success from a generic scene-revision change. |

A transform drag follows this state path:

1. Tap selects locally and opens an edit lease.
2. Drag samples update local presentation every display frame. At most one
   coalesced preview per edit session is emitted at the configured preview rate.
3. Pointer release creates a durable transform mutation and holds its local
   presentation in `awaiting-result`.
4. Rejection removes the optimistic layer immediately and exposes the
   authoritative item. Acceptance changes it to `awaiting-canonical`, anchored
   to the returned authoritative item and `sceneRevision`.
5. The presentation layer releases only when canonical state has reached that
   revision and contains the accepted item state (or deletion tombstone). It
   cannot snap back merely because a timer elapsed.

Cancel, selection supersession, lease expiry, disconnect, and explicit end all
stop preview production and cause the relay to send the committed transform to
the current host. Socket reconnect cancels transient edit sessions but resends
unacknowledged durable mutations with the same IDs. On host migration, the
relay grants the canonical snapshot first and then replays each latest active
preview with its sequence; stale-host events remain fenced by `hostEpoch`.

#### Test-driven implementation slices

Each slice is a separately verified commit. Tests are added before production
code and only affected suites are run before committing.

1. **Core and protocol model.** Add `itemRevision`, typed mutation unions,
   edit-session messages, preview sequence, authoritative results, and reject
   codes. Regenerate TypeScript and Go protocol code and update snapshot/protocol
   round-trip tests and prerelease fixtures.
2. **Relay transaction authority.** Add edit leases, per-item revision checks,
   typed validation results, receipt deduplication, disconnect/expiry cleanup,
   persisted receipt-window state, and accepted authoritative broadcasts. Cover
   the room event loop and both memory/file store conformance.
3. **Client transaction machine.** Replace anonymous command construction with
   edit handles, per-item queues, mutation receipts, reconnect resend, and
   frozen observers in `DurableCommandSession`. Remove the global preview slot,
   `preview` boolean, and generic mutation rejection effect.
4. **Presentation integration.** Replace the 1.5-second map with
   transaction-keyed optimistic layers and canonical-revision release. Wire
   `ItemEditInteraction` and `CanvasRuntime` to handles/receipts and keep local
   pointer presentation at display cadence.
5. **Consumer migration.** Convert item studio and every other example to
   render pending/accepted/rejected state from the matching receipt. Remove
   scene-revision inference and demonstrate conflict/edit-in-use feedback.
6. **Fault and packed-consumer gate.** Exercise the built package through the
   real relay under preview loss/reordering, delayed results, disconnect and
   retry, host migration, and concurrent browser contexts.

#### Acceptance boundary

The redesign is complete only when deterministic unit, relay, real-WebSocket,
and browser tests prove all of the following:

- dropped and reordered previews never reorder the host pose, and a later
  durable mutation converges every client;
- an arbitrarily delayed result holds the correct local presentation without a
  timeout, while a typed rejection restores authoritative state immediately;
- duplicate delivery and reconnect resend return the same receipt without a
  second revision increment or duplicate spawn/delete;
- two tabs using the same user cannot interleave previews for one item, and a
  stale same-item commit receives the authoritative conflict state;
- different items continue mutating concurrently;
- disconnect, edit-lease expiry, selection supersession, and explicit cancel
  restore the committed host pose and leave no timer, lease, or pending promise;
- host migration during a drag applies only the newest preview to the new host
  and preserves the eventual accepted result;
- overlapping selected items still route the pointer gesture to the selected
  entity; and
- no runtime or example waits for a magic duration or treats an unrelated scene
  revision as mutation success.

Out of scope for this slice: collaborative multi-user editing of one item,
undo/redo history, offline edits across a page reload, and product-specific
conflict resolution UI. The contracts above leave room for those features
without weakening single-authority mutation semantics.

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

### Replication and prediction timeline hardening

**Evidence.** `ReplicationTimeline` now solely owns history, interpolation,
reconciliation, tick gates, canonical publication, and host baselines
(`ec3cc0b`). Peer rubber-banding previously recurred around periodic
checkpoints and LAN delay, so extraction alone does not prove every useful
latency/jitter/rate combination.

**Redesign.** Expand the deterministic timeline matrix, then tune delta repair,
interpolation/extrapolation, teleport/reset thresholds, and reconciliation only
when a failing trace demonstrates a user-visible discontinuity. Session
orchestration must remain outside those algorithms.

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

1. Add acknowledged item mutations on top of `DurableCommandSession`.
2. Expand replication/prediction fault coverage on `ReplicationTimeline`.
3. Publish startup progress before asking external consumers to build polished
   loading/error UI.
4. Treat overlay layout and transient item actions as isolated follow-ups.
