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
in-canvas popovers. A configurable ownership treatment identifies items the local user can edit;
selecting one places frameless scale controls above it, rotation controls at
its sides, and finish/delete/more actions below it. Those controls may extend
outside the canvas instead of being clipped at an edge. Only a completed tap
selects an item; dragging from an unselected item does nothing. A later drag
manipulates the selected item with a display-rate local presentation while
authoritative preview messages remain rate-limited. Newly spawned items remain
unselected; tapping one or choosing it through Manage enters the same editor
selection state. The private
More menu holds item-specific controls such as three color presets, a custom
color picker, freeze, and collisions. Each user can drag, rotate, scale,
recolor, freeze, make collisionless, and delete their own items. The visitor
avatar is also a consumer-supplied texture rather than an engine placeholder.

The server keeps ordinary local state under `.data/v0.4.0`. That release scope
prevents snapshots from an intentionally incompatible library version from
making the current example unavailable; old data is preserved in place. Set
`CANVAS_EXAMPLE_DATA_DIR` to exercise a chosen durability or migration fixture.

The gold system ball maintains constant speed while collisions with the canvas,
avatars, and editable items change its direction, even while controls are open.
Editing does not stop the room. Freeze is an optional, durable per-item setting
that holds pose and pauses motion, behavior, and behavior timers while leaving
the item physically solid. Collision can be disabled independently, leaving
motion and behavior live while other entities pass through. Another tab sees the canonical item state, but never
sees the first user's selection outline or edit toolbar. The Manage popover
offers Aurora, Halo, and Badge ownership treatments for comparison.

The example imports only public Canvas package exports. It owns its canvas
definition, server item metadata, behavior worker, asset manifest, artwork, and
product UI. Canvas provides the generic projection, durable mutation, and
owner-authorized simulation-isolation seams.

During local development Vite proxies `/v1` HTTP and WebSocket traffic to the
room service on port 8083. LAN clients therefore need only port 5175 and use the
same origin for artwork and realtime room traffic. Set `VITE_SERVER_URL` to use
a separately exposed room-service origin instead.

The reactive orb is the editable behavior example: avatar contact triggers its
one-shot `pulse` animation and effect, while its color is durable configuration.
The color tile reuses the color-applying portion without a contact sensor. The
room-owned gold ball runs the constant-speed behavior. The current overlay does
not configure animation trigger policy or expose Play/Restart; that follow-up
requires a public transient owner-action path in addition to the existing
durable `setItemConfig` API.
