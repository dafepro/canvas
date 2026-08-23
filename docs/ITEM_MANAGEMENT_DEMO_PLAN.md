# Item management reference demo — alignment plan

## Outcome

Add an independently runnable `examples/item-playground` consumer that makes
Canvas's item model understandable without soccer context. It should demonstrate
content variety, authoritative editing, ownership enforcement, and custom
interaction behavior while importing only published Canvas package exports.

## Delivered slices

1. [x] **Structural scaling.** Uniform scale is an authoritative persisted
   transform, travels through the protocol, and atomically scales visuals and
   collider geometry. Emoji remain deterministic consumer textures.
2. [x] **Runnable content gallery.** The compact workbench includes bundled
   emoji-style art, a picture, a variant-configurable animated orb, and a
   behavior-driven contact effect. Every entry is ordinary definition and asset
   data owned by the example.
3. [x] **Management workflow.** Selection, drag preview/commit, rotation,
   uniform scaling, configuration, deletion, and pending/accepted/rejected UI
   use public runtime APIs.
4. [x] **Ownership scenarios.** Two named clients see the same items. The item
   list permits attempts against another user's items and a room-owned stamp so
   authoritative rejections are observable.
5. [x] **Consumer proof.** The definition/asset/behavior contract, production
   bundle, and clean packed-artifact installation are covered. The existing
   real-server two-client suite verifies ownership metadata on both clients;
   browser smoke testing covers accepted and rejected playground workflows.

## Alignment decisions

- Uniform scale belongs in `Transform` and scales visuals plus all collider
  shapes atomically. Non-uniform scaling stays out of this example.
- Owner-only move/rotate/scale/configure/delete remains the default;
  sharing, transfer, and claim policies are separate later capabilities.
- Pictures are bundled. Durable uploads require product-owned storage and are
  not implied by the Canvas room service.
- Emoji use a consumer texture so rendering is deterministic across clients;
  live text would require a separate font/text asset contract.
