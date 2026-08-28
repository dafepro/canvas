# Authenticated transient actions

Transient actions carry momentary product intent—Play, Restart, launch, or a
named trigger—without disguising it as durable item configuration. They do not
change scene, item, checkpoint, or configuration revisions and are absent from
snapshots. A behavior can still emit an existing durable command; that command
uses the ordinary authorized mutation path independently.

## Application registration

The Go host opts in with `roomsdk.Config.TransientActions`. With no registry,
all action names are rejected as unknown and existing rooms behave exactly as
before. The registry receives a trusted `TransientActionContext` containing the
room, authenticated participant, target, action name, and bounded valid JSON.
It validates product action names, payload schemas, and additional product
permissions.

Item actions are accepted only when the item exists and the authenticated
participant owns it. They dispatch to that item. Room actions have no item
target; the registry returns a `DispatchEntityID` for the application-owned
system behavior that should receive the event. Canvas verifies that behavior
item exists before dispatch.

```go
type Actions struct{}

func (Actions) ResolveTransientAction(
    _ context.Context,
    request roomsdk.TransientActionContext,
) (roomsdk.TransientActionRoute, error) {
    if request.Action != "round.restart" {
        return roomsdk.TransientActionRoute{}, roomsdk.ErrTransientActionUnknown
    }
    if request.Target != roomsdk.TransientActionTargetRoom {
        return roomsdk.TransientActionRoute{}, roomsdk.ErrTransientActionUnauthorized
    }
    // Validate request.Payload against the product schema here.
    return roomsdk.TransientActionRoute{DispatchEntityID: "round-controller"}, nil
}
```

## Runtime submission

`RoomSession` and `CanvasRuntime` expose `submitTransientAction`. The receipt
contains a generated request ID and a promise for one accepted/rejected result.

```ts
const receipt = runtime.submitTransientAction({
  action: "rocket.launch",
  target: "item",
  entityId: selectedRocketId,
  payload: { power: 2 },
});
const result = await receipt.result;
```

The server discards client-supplied participant and dispatch identities and
fills both from authentication and registry output. Accepted actions become an
`owner.action` event in the active simulation host, including `userId` and
`payload`. Effects and durable commands produced by that behavior follow their
normal authority paths.

## Delivery and limits

Actions use reliable WebSocket delivery on the current connection but are
never queued for reconnect. The active room keeps a bounded, non-persisted
result ledger keyed by authenticated participant, client session, and request
ID. A duplicate receives the same terminal result without another behavior
dispatch; an evicted older ID is rejected as stale. Room sleep drops the ledger
and snapshots never contain actions.

JSON size, result retention, per-participant rate, registry timeout, and the
separate action ingress queue are bounded. Reliable state traffic receives a
priority scheduling opportunity ahead of actions. Optional metrics report
accepted and rejected actions with stable reasons.
