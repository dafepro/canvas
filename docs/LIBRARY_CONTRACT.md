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

`subscribeLifecycle`, `start`, `whenReady`, `stop`, and `stopGracefully` define
route ownership, backgrounding, reconnect, and terminal teardown. Consumer
failures use `CanvasConsumerError`, not string parsing. See
`docs/RUNTIME_LIFECYCLE.md`.

`docs/PARTICIPANT_LIFECYCLE.md` defines identity lifetimes, reconnect
supersession, inactive/disconnected projection, and the product-owned avatar
placement hook.

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
- `ARCHITECTURE.md` defines authority and dependency direction inside Canvas.
