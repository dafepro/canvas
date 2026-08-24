# Linked-room travel hardening and pre-mortem

This document records the failure model for replacing one live Canvas room with
another. It is a library contract, not an application-specific world model.

## Transaction boundary

Room travel is a client-coordinated staged replacement:

1. Resolve and authorize an exact reverse link from the active room.
2. Open the destination using a room-scoped credential and requested arrival
   spawn point.
3. Wait for assets, JOIN, physics initialization, and presentation mounting.
4. Activate the destination and install its targeted-effect subscription.
5. Commit the navigator's current-room pointer and reload-safe application URL.
6. Unsubscribe and gracefully close the origin.

Steps 1–3 are rollback-safe: failure closes the staged destination and leaves
the origin active. If activation or subscription installation partially changes
presentation, the navigator closes the destination and reactivates the origin.
After step 5 the destination is authoritative; an origin-close failure is
reported but cannot roll the user back into a half-closed runtime. Consumer
callbacks are isolated from this state machine.

The URL is changed only after commit. Reload before commit therefore opens the
origin; reload after commit opens the destination. The example validates the
`room` parameter against its fixed room graph and falls back to the village for
unknown values.

## Identity boundary

Canvas enforces one live connection for one authenticated participant **within
one room**. A newer same-room connection wins; the displaced runtime receives a
terminal `session_superseded` error and cannot reconnect into a takeover loop.
Simultaneous tabs must use different identities if they are intended to appear
as different avatars.

The same participant may briefly connect to origin and destination rooms during
staging. Rooms are otherwise independent: Canvas does not claim to be a global
player-location or account-session service. Two independently controlled tabs
using the same authenticated identity in different rooms can therefore coexist.
If either enters the other's room, the newer same-room connection supersedes the
older one deterministically.

A product requiring exactly one global location per account must enforce that
policy while issuing destination credentials—for example with a participant
location lease or transactional travel ticket. That service belongs beside the
product's authorization and world graph; inferring global location inside the
generic physics relay would make unrelated canvases mutually exclusive.

## Pre-mortem matrix

| Failure | Required outcome | Coverage |
| --- | --- | --- |
| Same identity opens twice in one room | New connection wins once; old session fails terminally; no reconnect duel | Go room test and real-WebSocket client test |
| Same identity stages another room | Both room-scoped connections may coexist until origin close | Go cross-room overlap test and linked-room E2E |
| Peer travels away and returns while host remains | Host lease stays with host; peer avatar and input resume; both retain the system door | Linked-room real-server E2E |
| Reload after returning | URL selects the committed room; avatar rejoins; door and host state remain visible | Route-state test and linked-room real-server E2E |
| Host grant races physics initialization | Newest role and durable snapshot win; checkpoint revision advances instead of restarting | Simulation-kernel race regression |
| Host leaves during/after travel | Replacement host rebuilds from the latest durable snapshot and system items | Relay migration suite and kernel race regression |
| Destination auth, JOIN, assets, or mount fails | Staged destination closes; origin stays active | Navigator rollback tests |
| Destination activation/subscription fails | Destination closes and origin presentation is reactivated | Navigator rollback test |
| Consumer `onChanged`/`onError` throws | Committed navigation and cleanup continue | Navigator callback-isolation test |
| Duplicate travel effects arrive during transition | One transition runs; subsequent request coalesces | Navigator transition gate |
| Requested arrival spawn is missing | Destination initialization fails before commit; origin remains | Runtime lifecycle test |
| Reload occurs mid-transition | Pre-commit URL returns to origin; post-commit URL returns to destination | Commit ordering plus route-state test |
| Origin graceful close times out or throws | Destination remains current; failure is reported | Navigator post-commit close handling |
| Portal contact begins at sprite edge | No travel request until avatar centre reaches the visual midpoint | Real Rapier contact test |

## Remaining production extension

An optional conformance contract for a product-owned global participant-location
lease remains useful for RPGs and other single-location worlds. It should issue
room-scoped travel credentials, make destination commit idempotent, expire
abandoned origin leases, and expose a resume location for a new device. It must
remain outside the core room relay so independent canvases can still be open by
the same account when a product permits it.
