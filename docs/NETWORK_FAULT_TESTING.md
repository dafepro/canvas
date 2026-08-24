# Network fault testing

Canvas exports `FaultInjectingWebSocketTransport` from
`@canvas-physics/client/testing`. It wraps the real Canvas WebSocket transport,
so tests exercise normal encoding, credentials, room admission, relay behavior,
and reconnect machinery while applying repeatable faults at the client edge.
It is a test utility, not a production transport.

```ts
import { FaultInjectingWebSocketTransport } from
  "@canvas-physics/client/testing";

const transport = new FaultInjectingWebSocketTransport({
  credentialProvider: getRealtimeCredential,
  faults: {
    inboundDelayMs: 100,
    inboundJitterMs: 20,
    inboundLoss: 0.25,
    reorderEvery: 3,
    reorderDelayMs: 180,
    random: seededRandom,
  },
});
```

## Fault model

- `inboundDelayMs` adds one-way delay to every inbound envelope. Optional
  `inboundJitterMs` varies it symmetrically without allowing negative delay.
- `inboundLoss` and `outboundLoss` apply only to realtime payloads. Reliable
  coordination messages remain reliable because a WebSocket cannot selectively
  lose them without closing.
- `reorderEvery` holds every nth inbound realtime packet by
  `reorderDelayMs`. A later realtime packet can therefore arrive first while
  reliable coordination messages preserve order.
- `random` makes loss and jitter repeatable. Supply a seeded generator in any
  test that asserts an exact outcome.
- `droppedIn`, `droppedOut`, `delayedIn`, and `reorderedIn` prove that the
  requested fault was actually exercised. Closing the transport cancels all
  pending delayed deliveries.

Invalid loss rates are clamped to zero through one. Negative delay and jitter
are treated as zero. Reordering is disabled unless `reorderEvery` is at least
two.

## Repository coverage

`packages/client/test/packet-loss.test.ts` runs against a real `canvasd` process
and real WebSockets. The current matrix proves:

- a peer repairs canonical item state after deterministic 50% realtime loss;
- player input continues to move an avatar with deterministic 50% outbound
  realtime loss;
- peers converge after 50, 100, and 200 ms of one-way inbound latency while
  every second realtime packet is deliberately reordered;
- a reconnecting client does not retain a stale host role.

Separate real-process tests cover active host replacement, checkpointed item
and avatar restoration, timer-driven workflow continuation, sleeping-room
restart, and mid-workflow late joining. The remaining matrix combines these
lifecycle transitions with latency/reordering and adds a browser-driven
background/resume case; those remain explicit backlog items in `GAPS.md`.
