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

// Close the live socket without stopping the transport. Its ordinary
// credential refresh, reconnect, JOIN, and state-repair path runs normally.
transport.interrupt();
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
- `interrupt()` closes only the current live socket with a private close code.
  It returns `false` if no socket is open; otherwise the normal reconnect policy
  obtains a fresh credential and rejoins with a fresh connection ID.

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
- a peer refreshes credentials, rejoins with a new connection identity, and
  converges while delayed and reordered state continues to arrive;
- a reconnecting client does not retain a stale host role;
- an active replacement host preserves a moving avatar and completes a
  checkpointed timer workflow after receiving the old host's state through the
  same latency and reordering profile.

Separate real-process tests cover active host replacement, checkpointed item
and avatar restoration, timer-driven workflow continuation, sleeping-room
restart, and mid-workflow late joining. A browser-driven background/resume case
under injected faults remains an explicit backlog item in `GAPS.md`.
