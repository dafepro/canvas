# Canvas 0.4.1

Canvas 0.4.1 is a compatibility-preserving patch release for the 0.4 line. It
does not change the public TypeScript API, Go rooms SDK, protobuf protocol, or
durable room contract introduced by 0.4.0.

## Fixed

- Reference example servers now store disposable local state beneath a
  release-scoped directory such as `.data/v0.4.1`. An older development
  snapshot can no longer make a newer example reject its room as unavailable.
  Existing directories remain untouched and can be selected explicitly with
  `CANVAS_EXAMPLE_DATA_DIR` for migration or durability testing.
- All four package server commands use one validated launcher, keeping ports,
  canvas catalogs, definition catalogs, and data-directory behavior aligned.
- The basketball example now has a self-contained TypeScript configuration and
  therefore builds correctly as an external consumer of packed packages.

## Verification added

- Every reference example opens its declared room through a real `canvasd`
  process in the maintained E2E gate.
- Soccer exercises its real behavior and initial match state.
- Item playground spawns every authoritative definition, checks accepted
  revisions, verifies canonical entities, and proves always-live behavior.
- Linked rooms and basketball retain their real-service behavior suites.
- Client and server definition catalogs must match exactly for every example.
- The packed external-consumer gate now installs and builds all four examples.

The source release and Go module tags are `v0.4.1` and `server/v0.4.1` on the
same commit. npm packages are not part of this release because registry
credentials are not configured on the release host.
