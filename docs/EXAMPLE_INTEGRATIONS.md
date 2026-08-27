# Reference integration contract

Reference integrations are executable consumer contracts. They show how a
product composes Canvas without moving product rules into the library, and they
must remain useful enough to expose missing extension seams.

## Required shape

Each example:

- lives under `examples/<name>` with its own package, build, test, and run
  commands;
- imports Canvas only through documented package exports;
- owns its canvas definition, authoritative server JSON, behaviors, worker
  entry, art, product UI, and product policy;
- runs against the reference rooms service without modifying that service;
- includes deterministic behavior tests and a production bundle check;
- keeps ordinary development snapshots under `.data/v<library-version>` so an
  intentional storage-contract break cannot make a newly checked-out example
  look broken; `CANVAS_EXAMPLE_DATA_DIR` opts into a specific durability or
  migration fixture;
- proves its authoritative JSON/client definition parity and boots its real
  room through `canvasd`; behavior-driven examples additionally verify their
  initial canonical entities and behavior state, while authoring examples
  submit their complete spawn catalog;
- names every missing generic capability it works around; and
- is verified against clean installs of packed release artifacts.

Examples are executable compatibility fixtures for their documented use cases,
but they are not the complete public API baseline. A public contract change must
keep them building from packed artifacts and follow the release compatibility
policy; updating an example alone does not authorize removal of the old path.
The cross-platform CI gate runs these real-process smoke tests and builds every
example from packed release archives.

## Linked rooms reference integration

`examples/linked-rooms` demonstrates reversible travel among independently
hosted Canvas rooms. A built-in sensor behavior emits a reliable, targeted
travel request when an avatar crosses a door threshold. The application then
resolves the data-only route, authorizes it, obtains destination credentials,
and stages a second `CanvasRuntime` before replacing the visible room.

The village connects to both a cave and an original pixel-art adventure room;
all four directional links are declared as exact reverse pairs.
`RoomLinkGraph` rejects the application topology at startup if either side is
missing or mismatched. The destination contains a physical return door, while
the application Back button uses `LinkedRoomNavigator.back()` as an escape
hatch if collision geometry, placement, or product UI ever makes that door
unreachable. Departure presentation hides and disables the traveler while the
destination stages, then restores it if opening fails. The pixel room pairs its
consumer-owned background with matching collision geometry and includes a
synchronized ball whose configurable kick impulse exceeds simple avatar
momentum transfer. A failed destination open leaves the origin runtime active.

The example intentionally keeps room access outside Canvas. A host-authored
collision effect is a navigation request, not authorization; a production
consumer supplies its own authorization callback and room-scoped credential
provider. See `docs/LINKED_ROOM_TRAVEL.md` for the full lifecycle and trust
boundary.

## Item playground reference integration

`examples/item-playground` is a deliberately compact 36 × 24 workbench. Its
large-on-screen gallery shows that a consumer can supply pictures, rasterized
emoji-style art, texture variants, animation frames, and behavior effects
without adding product concepts to Canvas.

The in-canvas Spawn and Manage popovers exercise the public durable mutation
surface: spawn, direct placement, rotation, uniform visual-and-collider
scaling, configuration, optional simulation isolation, and deletion. Aurora,
Halo, or Badge projections mark items owned by the local user. Selection and icon edit
controls are local DOM overlays, so another participant receives the canonical
item updates but not the editor's private UI state. The server remains the
authority even though this consumer chooses to list only editable items.

Direct manipulation controls surround the selected item: scale above,
rotation at each side, and More/delete/finish below. More contains only the
controls relevant to that item. The controls may render outside the canvas
bounds. Only a completed tap selects; dragging from an unselected item does
nothing. A later drag moves the selected item with display-rate local
presentation layered over rate-limited authoritative previews. Three local ownership treatments demonstrate that product affordances
can vary without entering canonical room state. The example's avatar skin is
also supplied through the same consumer asset manifest as its item artwork.

Editing never changes the room into a separate mode. A room-owned gold ball
maintains constant speed while colliding with the canvas, avatars, and editable
objects while item controls are open. Consumers may explicitly freeze an owned
item while manipulating it; Canvas then preserves its pose and pauses motion,
behavior, and simulation-clock timers while the frozen item remains solid. The
independent collision override keeps an item
live while disabling its authored solids and sensors. A configurable color tile
combines three definition variants with a custom replicated sprite tint,
without adding product palette concepts to the engine.

The bundled picture is intentionally not an upload flow. Canvas handles asset
identity and loading, not durable media storage. A product can put uploaded
media behind its own stable URL and then express it through the same manifest
contract.

## Soccer lounge reference integration

`examples/soccer-lounge` is the first reference integration and the model for a
Zoomigo enrichment layer. Canvas owns synchronization, host election, physics,
input, rendering, and durable behavior state. The example owns field geometry,
the soccer-ball behavior, score semantics, visual treatment, and lounge UI.

The first runnable slice must prove:

1. A top-down field combines an image with matching collision geometry.
2. A custom worker behavior lets avatars kick a match ball.
3. The ball cannot leave the pitch except through either goal mouth.
4. Entering a goal atomically increments shared score state while ordinary
   physics continues through a high-damping net region and rear backstop, then
   resets the ball to center after a configured delay.
5. A late joiner derives the same scoreboard from canonical behavior state.

The stable participant lifecycle projection retains identities after their
realtime connection disappears. The generic host hook disables their avatar
and delegates only placement; the soccer integration maps inactive and
disconnected members to deterministic bench slots without Canvas learning
about teams or benches.

The example registers consumer-owned artwork for Canvas's reserved `avatar`
visual definition. A bounded avatar projection then drives product-owned DOM
decoration at render cadence: each participant gets a white outlined name below
the sprite and a deterministic one-to-five-star crown following its upper arc.
The projection consumes the exact interpolated sample Pixi rendered, avoiding
a second motion model. The same decoration follows the stable avatar into the
bench projection, demonstrating that roster presentation can evolve
independently of Canvas physics and rendering internals.

The product-owned SVG field, generated ball atlas, goal texture, and player
sprite are loaded through the
versioned asset manifest and preload gate. The field texture is decorative;
the independently defined static colliders and goal sensors remain the
authoritative gameplay geometry. The hard-kick atlas animation is started by
the consumer behavior and synchronized by Canvas's generic animation channel.
Two immutable goal system items reuse one transparent net texture, with the
opposing goal expressed by a 180-degree item transform. Net drag, score zones,
and rear boundaries remain canvas configuration rather than renderer logic.

Glancing avatar contacts split relative velocity into normal and tangential
components. The soccer behavior—not Canvas core—configures lateral impulse
transfer, spin transfer, effective ball radius, and an angular-speed cap. This
keeps sports feel product-tunable while reusing generic behavior commands. The
`?kickAnimation=0` test mode removes only the deformation atlas so physical
rotation direction can be reviewed without visual noise.

With `?overlay=1`, the opt-in DOM `Match ball` marker uses the bounded
overlay-projection subscription at 10 Hz. It demonstrates that a product can
align HTML with an interpolated entity without reaching into Pixi, observing
every render frame, or retaining mutable renderer state. It stays out of the
normal lounge UI.

The canvas definition's `systemItems` materializes exactly one match ball on a
new room. System items have no participant owner and reject participant move,
configuration, rotation, and delete commands.

## Basketball arena reference integration

`examples/basketball-arena` is a compact configuration-first full-court game.
Its authoritative canvas owns mirrored hoop placement, matching backboards and
rim collision, circular score sensors, localized net damping, player tuning,
spawn points, two immutable scoreboard items, and the immutable system ball.
The right hoop uses definition-level horizontal art mirroring rather than a
180-degree physics transform. The ball's resolved configuration
owns impulse feel, team-award tags, points per basket, winning score, possession
and game-reset delays, and the center reset location.

The consumer behavior therefore contains no court coordinates or hard-coded
match values. It maps configured contacts and region tags into physics commands
and durable score state. Ordinary physics continues during the score display;
the ball then teleports to the configured center. Reaching the configured win
threshold presents the winner before atomically resetting both scores and the
ball for a new game. A sleeping-room wake also centers the live ball so a stale
durable transform never becomes the opening possession.

The generated court, ball, mirrored hoop, avatar, and scoreboard shell remain
consumer-owned assets. Canvas preloads and renders world assets through its
public manifest. Product DOM projects the replicated behavior state at 60 Hz
onto the two scoreboard item positions through the CSS-pixel-safe overlay seam.
The rules message sits outside the playable frame, including in fullscreen.
The avatar fire trail is `SceneOptions.motionTrails` configuration: it filters
avatars and scales emission, size, lifetime, and alpha from their interpolated
speed. Fullscreen CSS gives the court the largest centered 5:3 rectangle in the
dynamic mobile viewport; Canvas observes that resized mount after orientation
changes and refits the camera and high-density backing buffer.
