# Room template reconciliation

Room wake never mutates canonical room contents to match a newer canvas
definition. A host application must explicitly call
`Server.ReconcileRoomTemplate` while the room is asleep.

The caller supplies the exact persisted `ExpectedCanvasVersion` and separately
authorizes three operations:

- add desired system items that are missing;
- replace existing system-owned items with the desired definition, transform,
  and resolved configuration; and
- retire system-owned items absent from the desired template.

Replacement intentionally clears the old system item's behavior state, timers,
and visual variant. Participant-owned items are never added to, replaced by, or
retired through this API. A desired system ID that collides with a
participant-owned item fails the entire reconciliation.

Reconciliation validates exact definition versions, configuration schemas,
transforms, item limits, and complex-physics limits before saving anything. A
successful operation advances canvas, scene, and checkpoint revisions once,
sorts the resulting items and operation report deterministically, and stores
one normalized snapshot. An awake room, stale expected version, or older target
definition fails without changing persisted state.

This API is the offline migration mechanism. Dynamic product room-to-template
selection remains a separate concern: the product must eventually resolve a
room instance such as a Zoomigo team lounge to a chosen canvas template before
the rooms SDK loads or reconciles it.
