# Release and compatibility contract

Canvas supports external application clients. A released artifact is an
immutable client contract: an npm archive or Go module tag must never be replaced or republished
with different contents under the same version.

## Compatibility policy

- Preserve documented TypeScript exports, runtime behavior, rooms SDK
  interfaces, HTTP routes, protobuf fields, JSON schemas, persisted state, and
  configuration semantics throughout a stable 1.x-or-later major line.
- Prefer additive fields and methods. Existing fields keep their meaning and
  defaults; removed protobuf field numbers and enum values stay reserved.
- Deprecate before removal and provide a migration path once the project enters
  its stable 1.x line. During the current 0.x design period, a minor release may
  deliberately remove obsolete contracts; every such break is accumulated in
  `MAJOR_VERSION_NOTES.md` with its affected contract, client impact, and
  migration.
- Bug fixes may reject input that never satisfied the documented contract, but
  the release notes must identify compatibility-sensitive validation changes.
- Patch releases preserve their minor line. Before 1.0, minor releases may be
  backward-incompatible only when the migration ledger is complete and the
  release advances all coordinated artifacts. Released versions remain
  immutable; prerelease status never permits republishing changed contents.

## Wire and durable-data compatibility

Clients and hosts currently require an exact `PROTOCOL_VERSION`. Additive
protobuf fields do not require a protocol bump: protobuf readers ignore unknown
fields, so old and new peers keep interoperating. Increment the protocol version
only for an incompatible semantic or wire change. Prefer a staged server that
can accept the old and new versions during rollout; if that is impractical,
record the coordinated deployment in `MAJOR_VERSION_NOTES.md` before merging.
`proto/wire-contract.v{PROTOCOL_VERSION}.txt` freezes every released message
field number, scalar/message type, repetition label, oneof membership, enum
number, and reservation. The release gate permits additive declarations but
fails if a released signature is removed or repurposed under the same protocol
baseline.

Snapshots and behavior state have independent schema versions. The current
snapshot schema must be validated before use. A durable shape change requires a
complete migration chain or an explicit major-version migration; it must never
be accepted by an older decoder and silently rewritten with fields discarded.
Item definition versions match exactly because a newer definition is not proof
that it preserves an older definition's physics or behavior.
Fields represented as protobuf `uint32` are JSON integers no greater than
`4294967295`. Snapshot counters represented as protobuf `uint64` remain in
JavaScript's non-negative safe-integer range. The TypeScript and Go validators
enforce those shared domains, and both accept positions exactly on the
four-times canvas slack boundary.
Live checkpoints and persisted room wakes enforce the same identity, revision,
counter, transform, timer, configuration, definition-version, and item-limit
rules. Restarting a room cannot turn rejected live state into accepted durable
state. Explicit template reconciliation validates the old snapshot's integrity
while permitting only the canvas and definition-version differences that the
reconciliation operation is responsible for replacing.

## Coordinated artifacts

One source commit and semantic version define a Canvas release:

- `@canvas-physics/core`
- `@canvas-physics/protocol`, including generated TypeScript bindings
- `@canvas-physics/client`, including the default worker and worker runtime
- `github.com/dafepro/canvas/server`, including generated Go bindings and the
  rooms SDK

The root and JavaScript package versions must match. The Go submodule uses the
same semantic version with a `server/vX.Y.Z` repository tag. Source releases
use matching `vX.Y.Z` and `server/vX.Y.Z` tags on one commit and verify all npm
archives before pushing. Once registry publication begins, JavaScript registry
artifacts and both tags must refer to that same commit; publishing only part of
that coordinated registry release is unsupported.

Any `room.proto` change regenerates both bindings in the same commit. Release
verification runs the package-artifact, public API fingerprint,
library-boundary, release-contract, TypeScript protocol/client, and Go rooms SDK
tests before publishing or tagging. The required Windows/Linux checks and local
reproduction commands are defined in `CI_RELEASE_GATE.md`. CI produces release
candidates but never publishes or tags implicitly.

## Dependency direction

Reusable packages follow `core <- protocol <- client`. Runtime dependencies are
allowlisted by `test/library-boundaries.test.ts`; package source cannot reach
into another package or an application by relative path. Product code depends
on Canvas only through published packages and documented host interfaces.
