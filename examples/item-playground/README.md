# Live item studio

An independently runnable Canvas consumer on a compact 36 × 24 workbench. It
shows consumer-owned artwork and behavior together with authoritative item
management, ownership enforcement, and always-live editing.

From the repository root, run:

```bash
pnpm example:items:server
pnpm example:items
```

Open <http://localhost:5175/?autojoin=1&user=maker-one>. For the ownership
scenario, open another tab with `user=maker-two`. Spawn and Manage are compact
in-canvas popovers. A green outline identifies items the local user can edit;
selecting one places frameless scale controls above it, rotation controls at
its sides, and finish/delete/more actions below it. Those controls may extend
outside the canvas instead of being clipped at an edge. The first pointer
gesture selects only; a later drag manipulates the selected item. The private
More menu holds item-specific controls such as three color presets, a custom
color picker, freeze, and collisions. Each user can drag, rotate, scale,
recolor, freeze, make collisionless, and delete their own items. The visitor
avatar is also a consumer-supplied texture rather than an engine placeholder.

The gold system ball maintains constant speed while its collision response
changes direction, even while controls are open. Editing does not stop the
room. Freeze is an optional, durable per-item setting that pauses motion,
collision, behavior, and behavior timers while preserving pose. Collision can
also be disabled independently, leaving motion and behavior live while other
entities pass through. Another tab sees the canonical item state, but never
sees the first user's selection outline or edit toolbar. The Manage popover
offers Aurora, Halo, and Badge ownership treatments for comparison.

The example imports only public Canvas package exports. It owns its canvas
definition, server item metadata, behavior worker, asset manifest, artwork, and
product UI. Canvas provides the generic projection, durable mutation, and
owner-authorized simulation-isolation seams.
