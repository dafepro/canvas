# Prerelease and release contract

Canvas is prerelease software. Backward compatibility is explicitly rejected:
an incompatible contract replaces the old contract and increments
`PROTOCOL_VERSION`. Clients and hosts accept an exact protocol-version match
only. They fail fast on mismatch and contain no v1/v2 negotiation, legacy field
fallback, or compatibility branch.

Durable behavior-state migrations are different. A snapshot can outlive a
deployment, so a behavior that changes persisted state supplies a complete
`MigrationChain`. That does not make old network clients compatible.

## Coordinated artifacts

One source commit and semantic version define a Canvas release:

- `@canvas-physics/core`
- `@canvas-physics/protocol`, including generated TypeScript bindings
- `@canvas-physics/client`, including the default worker and worker runtime
- `github.com/dafepro/canvas/server`, including generated Go bindings and the
  rooms SDK

The root and JavaScript package versions must match. The Go submodule uses the
same semantic version with a `server/vX.Y.Z` repository tag. JavaScript registry
publication and that Go tag must refer to the same commit. A partial release is
not supported.

Any `room.proto` change regenerates both bindings in the same commit. Release
verification runs the package-artifact, library-boundary, release-contract,
TypeScript protocol/client, and Go rooms SDK tests before publishing or tagging.

Protocol v4 separates product `room_id` from the server-selected canvas
template. Its room routes are `/v1/rooms/{id}` and
`/v1/realtime/rooms/{id}`; the removed canvas-instance routes and JOIN
`canvas_id` field are not supported.

## Dependency direction

Reusable packages follow `core <- protocol <- client`. Runtime dependencies are
allowlisted by `test/library-boundaries.test.ts`; package source cannot reach
into another package or an application by relative path. Product code depends
on Canvas only through published packages and documented host interfaces.
