# Item playground

An independently runnable Canvas consumer on a compact 36 × 24 workbench. It
shows consumer-owned artwork and behavior together with authoritative item
management and ownership enforcement.

From the repository root, run:

```bash
pnpm example:items:server
pnpm example:items
```

Open <http://localhost:5175/?autojoin=1&user=maker-one>. For the ownership
scenario, open another tab with `user=maker-two`. Each user can drag, rotate,
scale, configure, and delete their own items. Attempts against the other user's
items or the room-owned stamp are rejected by the server and shown in the UI.

The example imports only public Canvas package exports. It owns its canvas
definition, server item metadata, behavior worker, asset manifest, artwork, and
product UI.
