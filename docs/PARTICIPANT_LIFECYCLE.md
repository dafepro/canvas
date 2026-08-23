# Participant identity and lifecycle contract

Canvas distinguishes three identities that must not be substituted for one
another:

| Identity | Lifetime | Source | Use |
| --- | --- | --- | --- |
| `participantId` | Stable across reconnects | Authenticated `userId` | Product roster and ownership |
| `connectionId` | One WebSocket connection | Rooms service | Relay, host lease, and diagnostics |
| `avatarEntityId` | Stable participant physics identity | `avatar:${participantId}` | Simulation and rendering |

The rooms service permits one live connection per participant in a room. A new
authenticated connection supersedes an older socket with the same participant
ID. This makes an overlapping reconnect deterministic without trusting a
client-supplied identity.

## Public projection

`subscribePresence` publishes immutable `ParticipantPresence` entries with an
`active`, `inactive`, or `disconnected` status. Active and inactive entries
have a current `connectionId`; disconnected entries retain their stable
participant and avatar IDs but have no connection ID. Canvas retains entries
observed by that client for the life of its `RoomSession` instead of converting
a disconnect into a roster deletion.

This is a lifecycle projection, not a durable roster store. A consumer such as
Zoomigo owns team membership and merges the projection with its product roster.
A client that joins after a member disconnected cannot discover that member
from Canvas alone. Participant history is discarded when the session ends.

## Physics projection

The host retains a known participant's avatar when its realtime connection
disappears, disables its physics, and reuses the same entity if it reconnects.
The same disabled projection applies while a connected participant is
inactive. Canonical entity state lets peers derive the inactive status.

Consumers may provide `projectParticipantAvatar(participant, context)` to
choose a position for a lifecycle transition. The hook is product-neutral and
must be deterministic from product data; Canvas does not define teams, benches,
or return-to-play policy. A returned position is applied as a teleport and is
replicated through ordinary canonical state.

The soccer lounge uses this hook to place inactive or disconnected members in
stable bench slots and return reactivated members to a team-side spawn.

## Presentation

An application may register consumer-owned visual data using the reserved
`avatar` definition ID. The renderer applies its sprite, size, anchor,
animation, and z-order, while Canvas retains authority over the avatar body and
collision model. If the definition is absent, Canvas draws a neutral fallback.

Participant names and product metadata are intentionally not baked into that
sprite contract. The soccer lounge combines `subscribePresence` with a bounded
avatar overlay projection to render its name labels and one-to-five-star
crowns, including their inactive bench state.
