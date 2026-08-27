# Cross-platform CI and release gate

Canvas is an independent, versioned library used by application clients. Its CI verifies the reusable
packages and rooms SDK without assuming a particular product, application
backend, identity provider, database, or deployment platform.

## Required checks

`.github/workflows/ci.yml` runs on every pull request, every push to `main`, and
manual dispatch. Repositories consuming Canvas should protect `main` with these
checks:

- **Generated protocol bindings** regenerates TypeScript and Go from the one
  `room.proto` contract and fails on any checked-in difference.
- **Cross-platform verification (ubuntu-latest)** builds the reusable packages,
  type-checks packages, examples, and Node-backed tests,
  installs their packed archives into clean external consumers, builds both
  reference integrations from those archives, runs the TypeScript suite, runs
  the scene/network load budget in an isolated process, and runs the Go suite
  with race detection.
- **Cross-platform verification (windows-latest)** runs the same gate on
  Windows, including the external packed-consumer installations and ordinary
  Go tests. Race detection remains a required Linux check because Go's race
  detector requires a C toolchain that is not part of the Windows contract.

The load budget is deliberately excluded from the broad Vitest invocation and
then run as its own required step. Its wall-clock settle window and traffic
measurement must not compete with the reconnect, packet-fault, migration, and
other real-process suites running in parallel. Isolation makes the fixed 20
KB/s resting-room threshold stricter and repeatable; CI does not raise or skip
the budget when a runner is busy.

The workflow has read-only repository permission and does not publish packages,
push generated files, create tags, or deploy an example. Passing CI means the
commit is a release candidate; publication remains an explicit maintainer
action under `RELEASE_CONTRACT.md`.

## What consumers may infer

A commit passing all required checks establishes that:

1. `@canvas-physics/core`, `@canvas-physics/protocol`, and
   `@canvas-physics/client` compile on the supported CI operating systems.
2. Their declared entry points and type declarations exist in the packed npm
   artifacts and install outside this monorepo.
3. Public testing, runtime, worker, and worker-runtime subpaths remain usable by
   independent consumers.
4. The public declaration fingerprint belongs to the coordinated release
   version, so an API change cannot silently redefine an existing artifact.
5. The soccer lounge and item playground build against only those packed public
   artifacts, catching missing files and accidental internal imports.
6. The generated TypeScript and Go protocol bindings match the checked-in
   protobuf contract, and their exact protocol versions agree.
7. The reusable Go rooms SDK passes its conformance and race-detection suite.

CI does not certify a consumer's custom behaviors, authentication adapter,
store adapter, room-template resolver, assets, or product UI. The conformance
kits in `CONFORMANCE_KITS.md` are the corresponding consumer-side gates.

## Reproduce locally

Install Node.js 22, pnpm 11.20.0, the Go version declared in `server/go.mod`,
and protobuf compiler 35.1. Then run:

```bash
pnpm install --frozen-lockfile
bash scripts/verify-generated.sh
pnpm -r --filter "./packages/*" build
pnpm typecheck
pnpm vitest run
go -C server test ./... -race
```

`verify-generated.sh` intentionally leaves regenerated differences in the work
tree when it fails, making the required commit visible. `protoc-gen-go` is
pinned to v1.36.12; the JavaScript generator is pinned by `pnpm-lock.yaml`.

## Release handoff

After the required checks pass, a release must still follow the coordinated
artifact rules in `RELEASE_CONTRACT.md`: one semantic version and source commit
for all JavaScript packages and the Go module tag. Partial releases are not a
supported state.
