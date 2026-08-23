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
selecting one opens a private icon toolbar next to it. Each user can drag,
rotate, scale, recolor, isolate from simulation, and delete their own items.

The gold system ball keeps bouncing while those controls are open to make the
always-live model visible. Editing does not stop the room. Isolation is an
optional, durable per-item setting that pauses collision, physics, behavior,
and behavior timers while preserving the item's pose; pressing play returns it
to the simulation. Another tab sees the item state, but never sees the first
user's selection outline or edit toolbar.

The example imports only public Canvas package exports. It owns its canvas
definition, server item metadata, behavior worker, asset manifest, artwork, and
product UI. Canvas provides the generic projection, durable mutation, and
owner-authorized simulation-isolation seams.
