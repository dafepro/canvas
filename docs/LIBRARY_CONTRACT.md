# Canvas library contract

Canvas is a product-neutral engine and room SDK. It owns generic simulation,
rendering, synchronization, persistence coordination, and the public extension
seams documented here. A consuming application owns domain rules, content,
teams, scoring, rosters, rewards, and product-specific authentication policy.

Canvas packages must never import a consumer package. Consumers may import the
published Canvas packages and provide data, behavior modules, workers, storage,
authentication, and metrics through documented interfaces. A product-specific
feature that can be expressed through those interfaces does not belong in
Canvas core.

## Observation contract

`RoomSession` and `CanvasRuntime` expose four application-facing subscriptions:

- `subscribePresence` publishes server-authenticated participant lifecycle.
  Participant IDs are stable product identities, connection IDs are ephemeral,
  avatar entity IDs remain stable through reconnect, and disconnected entries
  are retained for the life of the observing session.
- `subscribeCanonicalState` publishes complete, uninterpolated canonical entity
  snapshots with tick and scene revision. It excludes local prediction and
  renderer state.
- `subscribeBehaviorState` publishes the behavior state entries derived from
  the same canonical snapshot.
- `subscribeEffects` publishes transient effects and their serialized
  parameters.

Presence, canonical-state, and behavior-state subscriptions immediately replay
the newest snapshot when one exists. Effects are event streams and are never
replayed. Each method returns an unsubscribe function.

Published snapshots are frozen copies. A consumer must treat nested behavior
state and effect parameters as immutable and must not use an observer callback
to mutate Canvas state. Peer deltas carry forward definition, identity, owner,
and behavior state omitted from the compact packet, so every published
canonical snapshot remains complete.

Observer callbacks run synchronously at the source update cadence. Consumers
must enqueue expensive work rather than block simulation or network handling.

`subscribeOverlayProjection` is the renderer-safe exception for visual product
UI: it publishes filtered, capped, rate-limited plain screen projections of the
interpolated entities actually drawn. `projectWorldPoint` handles fixed product
anchors. Neither exposes Pixi or mutable camera state. See
`docs/OVERLAY_PROJECTION.md`.

`subscribeLifecycle`, `start`, `whenReady`, `whenPresented`, `stop`, and
`stopGracefully` define
route ownership, backgrounding, reconnect, and terminal teardown. Consumer
failures use `CanvasConsumerError`, not string parsing. See
`docs/RUNTIME_LIFECYCLE.md`.

`docs/PARTICIPANT_LIFECYCLE.md` defines identity lifetimes, reconnect
supersession, inactive/disconnected projection, and the product-owned avatar
placement hook.

## Durable item controls

Owner-authorized mutations include transform, uniform scale, configuration,
deletion, whole-item freeze, and global collision enablement. Freeze preserves
pose while holding the body fixed and pausing behavior and simulation-clock
timers. Its colliders remain active, so frozen items are still obstacles and
remain selectable/editable. Collision disablement is independent: physics
motion and behavior continue, but the item's authored solid and sensor
colliders are inactive. Both states are durable, server-authoritative,
replicated, and restored during host migration.

Direct manipulation may render an owner's current transform locally at display
cadence while reliable preview commands remain coalesced. The local pose is
held after pointer-up until canonical state observes the commit or a bounded
timeout expires. This presentation layer does not weaken server authorization
or increase the network preview rate.

Behaviors may publish an optional RGB sprite tint with `setSpriteTint`. Tint is
a generic render attribute, replicated with canonical entity state and stored
in checkpoints. Consumers still own the meaning and selection of colors.

## Rendering density

The renderer keeps canvas layout in CSS pixels but allocates a denser backing
buffer for high-density displays. `scene.resolution` defaults to the device
pixel ratio capped at 2, which avoids blurry enlarged pixels on phones and
retina-class screens without silently multiplying GPU cost beyond 4x. A
consumer may set an explicit positive resolution when its quality and device
budget call for a different tradeoff. This setting does not change world
coordinates, camera framing, collider dimensions, or visual-definition sizes.

## Avatar presentation

Consumers may register an item definition with the reserved ID `avatar` to
configure avatar sprite, size, anchor, variants, animation, and z-order through
the ordinary asset and visual-definition contracts. Canvas still owns avatar
body creation and collision; item body, collider, persistence, and behavior
fields are not an avatar-physics extension seam. When no `avatar` definition is
registered, the renderer uses its product-neutral circle fallback.

Names, ranks, crowns, teams, and roster state remain product UI. Consumers can
align those decorations with drawn avatars through the bounded overlay
projection API without importing Pixi or observing the render loop.

`CanvasRuntime` supports `thumbstick` and collision-safe `avatarDrag` pointer
input. While held, direct dragging places the avatar center at the pointer's
absolute world position in one simulation tick with no maximum speed. The host
sweeps the complete displacement against fixed, avatar-blocking geometry, so a
large pointer jump cannot tunnel through a wall. Solid canvas edges and fixed
colliders use a small contact skin, and the remaining displacement is projected
along every contacted surface. This makes all four edges and corners stable:
the avatar stays at the nearest reachable point, moves tangentially with the
pointer, and immediately follows a pointer returning to the interior. Open,
wrap, and respawn edges retain their authored semantics rather than being
converted into solid drag bounds. A quick release emits one
bounded flick, while a release below the configured pixel-speed threshold emits
no momentum. Gesture thresholds are client/runtime configuration. The canvas owns
`avatarController.flickDeceleration`, so host simulation and local prediction
agree on how the resulting slide comes to rest.
`avatarController.maxTurnSpeed` independently bounds facing changes, including
uncapped direct dragging, so a pointer correction cannot snap the avatar art
through a large angle in one simulation tick.
Consumers whose art has a fixed upright perspective set
`avatarController.facing` to `"fixed"`; the default `"movement"` retains
directional facing. During direct dragging,
`avatarController.directInteractionMaxSpeed` caps only the velocity exposed to
contact behaviors. Absolute pointer placement remains uncapped, preventing a
large pointer jump from becoming an unbounded authored kick or hit. Direct
targets are inset by the avatar radius, including on canvases with open edges.
Long direct moves use iterative shape casts against fixed avatar-blocking
terrain. This direct-position solver is deliberately separate from the
velocity controller: arbitrary pointer jumps can be much longer than one
physics step, including before the first world step. Up to eight simultaneous
contacts are resolved so compound corners cannot pin or tunnel.

Pointer ownership is an explicit `idle` / `pending` / `active` / `suspended`
state machine owned by one runtime coordinator. Item editing, avatar movement,
and consumer gestures compete through ordered claims instead of installing
independent DOM listeners. Once one claim begins, no other strategy observes
that pointer until exactly one terminal release or cancellation. See
`docs/POINTER_INTERACTIONS.md` for the public strategy and priority contract.
Once a direct grab begins, movement, release, cancellation, browser-window
exit, focus loss, and lost pointer capture are observed on the canvas's owning
window. Leaving the canvas while still held therefore keeps projecting the
pointer to the nearest reachable world edge. A lost capture or window exit
suspends the gesture and a subsequent held move resumes it; cancellation,
release, or a move with no primary button ends it and permits an immediate new
grab. Canvas never fabricates a release flick after cancellation.

Peers predict their local avatar for the newest input sequence. Canonical
updates acknowledge the last processed input sequence, and reconciliation
compares that state with the prediction recorded for the same sequence—not
with the newest pointer position. Delayed keyframes and checkpoints therefore
cannot pull newer tangential edge movement backward. Prediction history is
bounded and is reset on host-role changes.

`RuntimeDiagnostics.pointer` exposes the pointer phase, pointer ID, last local
point, and capture status; `pointerWorldTarget` exposes the projected world
target. Session diagnostics expose sent and acknowledged input sequences,
prediction-history depth, and current predicted/canonical avatar coordinates.
These fields are observational and must not be used as control inputs.

Consumer visuals may opt into `visual.mirrorX` or `visual.mirrorY`. Reflection
is presentation-only: world dimensions, anchors, transforms, and colliders do
not change. Definitions that omit the flags retain their source orientation.

`SceneOptions.motionTrails` is the product-owned seam for speed-derived local
particles. Filters select entity kinds or definitions; thresholds, emission
rate, palette, size, lifetime, and starting alpha are data. Canvas samples the
same interpolated velocity and position it draws, scales intensity between the
configured speeds, and never persists or networks the resulting particles.

Fullscreen presentation remains product-owned UI. A consumer may provide a
`fullscreenElement` and drive `enterFullscreen`, `exitFullscreen`, or
`toggleFullscreen`, with `subscribeFullscreen` keeping its control label in
sync. Canvas supplies no mandatory button, styling, or fullscreen layout. Its
renderer does observe the mount element itself, so a consumer's fullscreen or
orientation layout change updates camera fitting and backing-buffer resolution
without rebuilding the runtime.

## Room template items

Product room identity is independent from canvas template identity. The host's
required `RoomTemplateResolver` maps a room such as a Zoomigo team lounge to an
exact reusable canvas ID and version. Snapshots are isolated by room and retain
that binding; resolution conflicts fail closed. See `docs/ROOM_TEMPLATES.md`.

`CanvasDefinition.systemItems` declares the immutable baseline items for a new
room. The rooms service materializes them only when no snapshot exists, validates
their exact definition versions, resolved configuration, transforms, IDs, and
canvas limits, and gives them no participant owner. Participant durable move,
rotate, reconfigure, and delete commands therefore reject them as
`system_owned`. Physics and behavior commands still affect them normally.

Template items are definition data, not an implicit migration mechanism.
Changing a template requires a new canvas version and coordinated consumer
release; an existing room continues from its canonical snapshot unless the
host application explicitly reconciles that sleeping room with the policies in
`docs/ROOM_TEMPLATE_RECONCILIATION.md`.

## Related contracts

- `EXTENSION_CONTRACT.md` defines application behavior and worker ownership.
- `HOST_INTEGRATION.md` defines authentication and rooms SDK composition.
- `ROOM_TEMPLATES.md` defines product room and reusable template identity.
- `RUNTIME_LIFECYCLE.md` defines readiness, reconnect, teardown, and typed errors.
- `OVERLAY_PROJECTION.md` defines bounded DOM/UI projection observation.
- `POINTER_INTERACTIONS.md` defines exclusive pointer ownership and consumer gestures.
- `CONFORMANCE_KITS.md` tracks external extension and adapter verification.
- `ARCHITECTURE.md` defines authority and dependency direction inside Canvas.
