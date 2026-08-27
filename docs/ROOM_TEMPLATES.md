# Room and canvas template contract

A room is a product-owned multiplayer instance. A canvas is reusable,
versioned template data. They have separate identities: Zoomigo can resolve
`team:42:lounge` and `team:99:lounge` to `soccer-lounge@1`; each room keeps its
own participants, host lease, score behavior, items, and canonical snapshot.

The host must configure `roomsdk.Config.RoomTemplates`. Its
`ResolveRoomTemplate(ctx, roomID)` method returns an exact `CanvasID` and
`CanvasVersion`. It may query the product database, feature configuration, or
tenant policy. `StaticRoomTemplates` is intended for examples and small fixed
services.

Resolution follows these rules:

- clients connect with only a product `roomId` at
  `/v1/realtime/rooms/{roomId}`;
- the resolver, not the browser, selects the canvas template;
- canonical snapshots are stored by room ID and include the exact canvas ID
  and version to which the room is bound;
- two room IDs resolved to one canvas never share canonical state;
- every join and reconnect resolves again, but a result that differs from an
  awake or persisted room binding fails with `ErrRoomTemplateConflict`;
- room wake performs no template migration or version upgrade.

Every `Store` must retain immutable catalog generations and load the exact
`(canvasId, version)` or `(definitionId, version)` selected by a room or durable
item. An ID-only “latest” lookup cannot satisfy the contract because an awake
room and a sleeping room may legitimately be pinned to different generations.

For example, a Zoomigo host can implement `RoomTemplateResolver` by looking up
the authenticated team's lounge configuration and returning
`RoomTemplate{CanvasID: "soccer-lounge", CanvasVersion: 1}`. The product can
change that database binding only while the room is asleep and in coordination
with `Server.ReconcileRoomTemplate`; otherwise the next join fails instead of
silently moving participants into a different world.

The reference `canvasd` explicitly registers each loaded canvas as one static
room with the same textual ID. That is reference-service configuration, not an
SDK fallback or a compatibility branch.

Changing a persisted binding or adopting a newer canvas version uses the
offline operation in `ROOM_TEMPLATE_RECONCILIATION.md`.
