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
   placement. `CanvasRuntime.spawnPointId` applies that named spawn and rejects
   a missing point before the destination commits; the server still selects the
   destination room template.
8. Same-participant uniqueness is room-scoped. A newer connection supersedes an
   older connection in that room, while a staged origin/destination overlap is
   allowed. Products requiring one global account location enforce that policy
   while issuing destination credentials.
9. A staged destination must not be revealed merely because initialization is
   complete. It waits for presence and a canonical presentation containing all
   snapshot items and connected avatars.
10. An explicit arrival spawn wins during travel. A refresh without one resumes
    the participant's latest server-known canonical position.
11. A consumer may mark departure pending after authorization and before room
    staging. The reference integration immediately hides the local avatar,
    disables its input, and hides replicated disabled avatars so nobody watches
    the traveler continue beyond the threshold during the load. Failed staging
    restores both presentation and input before returning control.

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
room ID. The reference integration commits the current room to its URL, so a
refresh rejoins the committed room. Even without history, the graph and
destination room still expose the physical reverse route.

Activation and effect-subscription installation are part of the staged commit.
If either fails, the destination is closed and the origin is reactivated.
Consumer callbacks cannot interrupt navigation cleanup or corrupt the committed
current-room pointer. See `LINKED_ROOM_TRAVEL_HARDENING.md` for the pre-mortem
and cross-layer coverage matrix.

## Trust boundary

The browser simulation host is authoritative for room physics, so a travel
effect is a request, not an access grant. The application must authorize the
resolved link and obtain a credential scoped to the destination room. Rejecting
either leaves the current room running. A production service may derive its
allowed room graph from server-side product data and issue destination tickets
only for those links.

## Reference integration

`examples/linked-rooms` defines a bright village, a moonlit cave, and an
original pixel-art adventure room. The village branches through two differently
skinned system-owned doors, while each destination contains its exact reverse
door. Walking into either door replaces the visible runtime, and the Back button
demonstrates the programmatic fallback. The pixel room also proves that normal
synchronized dynamic items continue to work across linked-room boundaries with
a strongly kickable ball. A same-room duplicate visibly blocks the displaced
tab and offers an explicit “Use here” takeover instead of leaving a silently
frozen scene.
