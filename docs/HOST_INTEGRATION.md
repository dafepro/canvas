# Host integration contract

## Authentication

`roomsdk.Config.Store`, `roomsdk.Config.Auth`, and
`roomsdk.Config.RoomTemplates` are required. The SDK never selects development
authentication or a room-to-template mapping implicitly. The reference
`canvasd` opts in to `DevAuthenticator` and `StaticRoomTemplates` explicitly
for local use. See `ROOM_TEMPLATES.md` for dynamic product resolution.

The browser's `credentialProvider` returns an opaque, short-lived credential on
every initial connection and reconnect. `WebSocketRoomTransport` sends two
WebSocket subprotocol values:

1. `canvas-realtime`, the protocol selected by the rooms SDK.
2. The opaque credential, available to the host `Authenticator` in the
   `Sec-WebSocket-Protocol` request header but not selected or echoed.

The credential must be a valid WebSocket subprotocol token: non-empty and with
no whitespace or commas. A production host should issue an audience-restricted,
short-lived, replay-resistant ticket rather than placing a long-lived session
cookie or bearer token in this header. The host must validate the request
origin using `Config.AllowedOrigins` as well as validate the ticket.

The authenticated `Identity` is the only source of user ID and display name.
JOIN contains room compatibility data only. JOIN_ACCEPTED returns the identity
that the host authenticated, and presence derives from the same server-side
identity. A consumer must not infer identity from connection IDs.

## Development authentication

`devRealtimeCredential(userId, displayName)` and `DevAuthenticator()` form a
local-only pair. The identity is encoded but not signed. Neither API is an
authentication mechanism for a deployed product.

Non-browser tests may supply `X-User-Id` and `X-Display-Name` to
`DevAuthenticator`. Query-string identity is not supported.

An external host should run `roomsdktest.RunAuthenticatorConformance` against
its production adapter with representative valid, missing, expired, and
malformed tickets. See `CONFORMANCE_KITS.md`.

Database-backed hosts should also run `roomsdktest.RunStoreConformance` with a
fresh seeded namespace and a reopen callback. This verifies the catalog,
not-found, room-isolation, checkpoint-ordering, concurrency, and durability
semantics used by the rooms service.
