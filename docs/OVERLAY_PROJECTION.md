# Renderer-safe overlay projection

Product UI often needs an accessible DOM label, menu, reaction, or roster badge
to follow something drawn by Canvas. Consumers must not retain Pixi containers,
textures, or the mutable camera to do that. `CanvasRuntime` therefore exposes
plain immutable projection values at a bounded cadence.

## Entity observation

`subscribeOverlayProjection(observer, options)` samples the same interpolated
and locally predicted entities used for the rendered frame. Each entity carries
world and screen coordinates, identity and definition, rotation, visibility,
disabled/quarantined flags, and `inCanvas`/`inViewport` hints. The snapshot also
contains the canonical tick, sample time, canvas size, and an immutable viewport
projection (`width`, `height`, `scale`, `offsetX`, and `offsetY`). It contains no
renderer objects.

Screen coordinates are CSS pixels even when the Pixi backing buffer renders at
a higher device-pixel density. DOM overlays therefore keep their alignment on
high-DPI displays and through fullscreen resize transitions.

Subscriptions are deliberately bounded:

- `maxHz` defaults to 10 and cannot exceed 60. A 60 Hz subscription can track
  the exact interpolated sample used by each ordinary render frame;
- `maxEntities` defaults to 128 and cannot exceed 256;
- entity-ID and definition-ID filters accept at most 256 values;
- ID, kind, and definition filters run before the entity cap;
- matches are ordered by entity ID before truncation; and
- `matchedEntities` and `truncated` make incomplete results explicit.

Samples begin on the next eligible render frame. The observer returns an
unsubscribe function and all overlay observers are released when the runtime
stops. A throwing observer is isolated from rendering and other observers.

Render-attached decoration such as an avatar name should request 60 Hz and keep
its filter/entity cap narrow. Canvas publishes after drawing from the same
interpolated entity array, so the DOM transform and Pixi display share one
motion sample. Lower cadences remain appropriate for diagnostics, menus, and
labels whose motion does not need to read as part of the entity.

## Fixed world anchors

`runtime.projectWorldPoint({ x, y, z? })` projects a product-owned anchor such
as a goal label, bench marker, or context-menu origin through the current camera.
It returns immutable world/screen coordinates plus canvas/viewport containment,
or `undefined` before the scene is mounted. The pure `projectOverlayPoint`
helper supports consumer-owned renderer adapters using the same value contract.

The soccer lounge's avatar crowns and names are the render-attached reference:
they filter to at most 64 avatars and request 60 Hz. Its opt-in `?overlay=1` DOM
`Match ball` marker demonstrates the lower-cost diagnostic case by filtering to
one ball at 10 Hz. Neither imports or inspects Pixi, and the ball marker remains
absent from the normal lounge experience.
