# Room template reconciliation

Room wake never mutates canonical room contents to match a newer canvas
definition. A host application must explicitly call
`Server.ReconcileRoomTemplate` while the room is asleep.

The caller names the product room, supplies the exact persisted
`ExpectedCanvasID` and `ExpectedCanvasVersion`, supplies an exact target
`RoomTemplate`, and separately authorizes three operations:

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
successful operation updates the persisted room binding, advances scene and
checkpoint revisions once,
sorts the resulting items and operation report deterministically, and stores
one normalized snapshot. An awake room, stale expected binding, unavailable
target version, or same-canvas version rollback fails without changing
persisted state.

This API is the offline migration mechanism. `docs/ROOM_TEMPLATES.md` defines
how a product dynamically resolves that same room to its target template on
join. The product must update its resolver-owned binding in coordination with
this operation; a mismatch fails the next join rather than migrating on wake.
