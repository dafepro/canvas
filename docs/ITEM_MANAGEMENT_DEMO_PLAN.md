# Item management reference demo — alignment plan

## Outcome

Add an independently runnable `examples/item-playground` consumer that makes
Canvas's item model understandable without soccer context. It should demonstrate
content variety, authoritative editing, ownership enforcement, and custom
interaction behavior while importing only published Canvas package exports.

## Proposed slices

1. **Close structural gaps first.** Audit the current spawn/move/rotate/configure/
   delete APIs from a packed consumer. Specify uniform item scaling as an
   authoritative persisted transform that also scales collider geometry; do not
   disguise scale as product config. Decide whether emoji need a generic text
   visual or ship as consumer-generated textures.
2. **Runnable content gallery.** Add a palette with emoji/textures, uploaded or
   bundled pictures, an atlas animation, and one behavior-driven interactive
   effect. Every entry is an ordinary item definition plus asset manifest data.
3. **Management workflow.** Demonstrate selection, placement preview/commit,
   rotation, uniform scaling, configuration, and deletion with clear selected,
   pending, accepted, and rejected states.
4. **Ownership scenarios.** Run two clients side by side. Owners can manage
   their items; non-owners see authoritative updates and explicit rejections.
   Include system-owned and optionally unowned/claimable items only if those
   policies are deliberately selected.
5. **Consumer proof.** Add multi-client end-to-end coverage, packed-artifact
   installation/build verification, and documentation mapping each feature to
   either generic Canvas capability or demo-owned product policy.

## Alignment decisions before implementation

- Recommended: uniform scale belongs in `Transform` and scales visuals plus all
  collider shapes atomically. Non-uniform scaling stays out of the first slice.
- Recommended: owner-only move/rotate/scale/configure/delete remains the default;
  sharing, transfer, and claim policies are separate later capabilities.
- Choose whether “pictures” are bundled examples only or include a local file
  picker/object-URL flow. Durable remote uploads require a product storage port
  and should not be implied by the Canvas room service.
- Choose whether emoji must be live text. Raster emoji textures work today and
  are cross-renderer deterministic; live text would add a new font/text asset
  contract.
