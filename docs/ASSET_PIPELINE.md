# Asset pipeline contract

Canvas consumers own their artwork. The client owns the generic process that
validates, versions, loads, and renders it. The server and simulation worker
never fetch images and never use pixels as collision data.

## Manifest

An application may pass one `AssetManifest` to `CanvasRuntime`. Version 1 is an
exact prerelease contract; unsupported versions fail instead of entering a
compatibility path.

```ts
const assets: AssetManifest = {
  schemaVersion: 1,
  id: "soccer-lounge",
  revision: "2026-08-23.1",
  sources: [
    { id: "field", src: "/soccer-field.svg", required: true },
    { id: "ball-atlas", src: "/assets/ball.png", required: true },
  ],
  textures: [
    { id: "soccer.field", sourceId: "field" },
    {
      id: "soccer.ball.idle",
      sourceId: "ball-atlas",
      frame: { x: 0, y: 0, width: 256, height: 256 },
    },
  ],
};
```

- `id` identifies the consumer-owned collection.
- `revision` is appended to every source URL as a cache version. Change it when
  any referenced file changes.
- `sources` are loaded once. `required` is explicit: a failed required source
  prevents room startup; a failed optional source produces a warning.
- `textures` give stable logical IDs to whole images or pixel frames within an
  atlas. IDs are what canvas and item definitions reference.

The manifest must have unique source and texture IDs, non-empty values, valid
source references, and positive in-bounds frame dimensions. Runtime loading
also rejects atlas frames outside the decoded source texture.

## Preload gate and failure policy

`CanvasRuntime.start()` loads assets before opening the room connection. This
prevents a participant from appearing before required room art is usable.
Applications can observe immutable progress and warning events.

Browser applications observe loading through `CanvasRuntime.subscribeStartup`.
During the `assets` phase, `snapshot.assets` reports `settled`, `total`, and an
ordered source list whose status is `pending`, `loaded`, `warning`, or
`failed`. Reaching N/N advances to `credentials` or publishes `failed` in the
same startup machine, so N/N is never a misleading terminal loading message.
The lower-level `preloadAssetManifest` function exposes the same source-aware
`AssetProgress` to tooling that uses the asset package without a runtime.

Invalid manifests throw `AssetManifestError`. Required load or atlas failures
throw `AssetLoadError`. Optional failures use the existing definition
placeholder (or the scene background color) and report an `AssetWarning`.
Missing logical references always fall back visibly and report a warning; they
never silently select another asset.

## Rendering boundary

- `CanvasDefinition.backgroundAssetId` selects a texture stretched to the
  canvas's world bounds.
- `VisualDefinition.spriteId` selects an item's normal texture.
- `visual.variants[name].spriteId` may replace it for a named variant.
- `visual.animations[name].frames` lists texture IDs. `fps` and `loop` control
  playback. `startAnimation` synchronizes the name plus a replay epoch, so
  starting the same animation twice restarts it on every peer.
- World-unit `visual.size` and `anchor` control display geometry. Source pixel
  dimensions do not affect collision or world scale.
- Placeholder shapes remain the intentional asset-free and failure rendering
  path. Collision definitions remain code/data, never inferred from artwork.

This keeps examples such as the soccer lounge portable: the integration owns
the field and ball art plus the soccer rules, while Canvas only understands
textures, frames, animation names, world geometry, and loading policy.
