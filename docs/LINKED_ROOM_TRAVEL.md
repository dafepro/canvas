# Linked room travel

Linked room travel is a generic Canvas extension for doors, map exits, dungeon
stairs, elevators, and portals that replace the current room. Canvas detects an
authoritative avatar contact and delivers a reliable travel request; the
consumer remains responsible for deciding which rooms exist, issuing access
credentials, staging their presentation, and authorizing travel.

## Requirements

1. Only the active simulation host can produce a travel request, and only an
   avatar crossing the configured sensor threshold can be its target.
2. Travel requests use the reliable effect path and name a data-only `linkId`.
   Behavior code does not open URLs, choose credentials, or construct runtimes.
3. Every route has an exact reverse route. `RoomLinkGraph` rejects missing,
   mismatched, duplicate, empty, and same-room links during application startup.
4. The destination must join and become ready before the origin is closed. If
   authorization, credentials, assets, JOIN, or mounting fails, the origin stays
   active.
5. Only the client whose stable avatar entity is named by the request travels.
   Other participants remain in the original room.
6. A reverse in-world door and `LinkedRoomNavigator.back()` both use the same
   validated return link. The latter is a product UI escape hatch if the player
   cannot reach the return collider.
7. A consumer may use `arrivalSpawnPointId` to select or explain destination
   placement. Canvas treats it as an application-owned hint; the server still
   selects the destination room template.

## Public structure

`RoomTravelBehavior` is a built-in sensor behavior. A system-owned door item
configures `sensorId`, `linkId`, and a per-avatar cooldown. On `contact.enter`,
it emits `canvas.roomTravelRequested` with the colliding avatar as the effect
target. The effect is host-authored and travels over the reliable ordered
channel.

`RoomLinkGraph` validates the consumer's bidirectional topology and resolves a
link only from its declared origin room.

`LinkedRoomNavigator` listens only for effects targeting the current local
avatar. Its consumer-supplied `openRoom` factory obtains credentials, constructs
and fully readies a `CanvasRuntime` or `RoomSession`, and returns a small room
handle. The navigator activates that staged destination, switches its effect
subscription, then closes the origin. Concurrent contacts are coalesced.

The navigator does not persist travel history. A product that wants browser
refresh to preserve a navigation stack should persist its own route or current
room ID. Even without that history, the graph and destination room still expose
the physical reverse route.

## Trust boundary

The browser simulation host is authoritative for room physics, so a travel
effect is a request, not an access grant. The application must authorize the
resolved link and obtain a credential scoped to the destination room. Rejecting
either leaves the current room running. A production service may derive its
allowed room graph from server-side product data and issue destination tickets
only for those links.

## Reference integration

`examples/linked-rooms` defines a bright village room and a cave room. Each has
one system-owned threshold item configured with one side of a validated route.
Walking into the door replaces the visible runtime; the cave contains the exact
reverse door, and the Back button demonstrates the programmatic fallback.
