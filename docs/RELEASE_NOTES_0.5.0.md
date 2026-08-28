# Canvas 0.5.0

Canvas 0.5.0 adds application-authorized durable mutations and trusted
server-side mutation reconciliation. The release is additive: protocol version
8 remains wire-compatible, existing mutation calls keep their behavior, and a
host that configures neither new seam behaves as before.

## Application-authorized mutation permits

- Every client mutation API accepts optional opaque authorization evidence and
  an application correlation ID. Neither is exposed in canonical room state.
- `roomsdk.Config.MutationAuthorizer` receives authenticated participant,
  room/canvas identity, mutation kind, exact definition or target item,
  normalized proposed state, and a stable idempotency identity only after
  Canvas validation succeeds.
- Policy denials and infrastructure failures have distinct stable rejection
  codes. Timeouts, errors, and panics fail closed; retained duplicate delivery
  cannot consume a permit twice.
- `roomsdktest.RunMutationAuthorizerConformance` verifies application-owned
  permit binding and replay rules.

## Trusted mutation reconciliation

- `Server.ReconcileMutation` returns immutable accepted, rejected, unknown, or
  expired outcomes from a server-private durable ledger. No browser route is
  exposed.
- Accepted outcomes identify the authenticated participant, room, mutation,
  canonical entity and exact definition version, scene revision, and item
  revision. Rejections use stable codes rather than diagnostic text.
- Retention duration and per-room size are configurable and observable through
  `MutationOutcomePolicy` and the reference metrics exporter.
- Optional outcome-sink failures do not roll back accepted mutations. The
  durable query remains available for retry.
- Memory and file stores preserve the private ledger across service replacement,
  and external Store conformance covers the new additive snapshot fields.

See `docs/ITEM_MUTATIONS.md` for the complete integration and retention
contract.
