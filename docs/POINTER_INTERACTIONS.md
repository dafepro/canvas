# Pointer interaction contract

`CanvasRuntime` has one pointer event owner. The
`PointerInteractionCoordinator` normalizes browser events, asks ordered
strategies to claim a pointer, owns capture and window tracking, and delivers
exactly one terminal release or cancellation to the winning claim. Avatar
movement, owner item editing, and application gestures do not install competing
DOM listeners.

## Built-in ordering

The highest-priority strategy that returns a claim on pointer-down wins. Equal
priorities retain registration order. Canvas publishes stable reference points:

| Strategy | Priority | Pointer-down behavior |
| --- | ---: | --- |
| Avatar movement | `pointerInteractionPriorities.avatarMovement` (100) | Direct-drag claims only near the local avatar; thumbstick claims otherwise unclaimed space. |
| Owner item editing | `pointerInteractionPriorities.itemEdit` (200) | Claims an owned item before avatar movement. A tap selects it; a drag on an unselected item intentionally does not select or move it. A later drag moves the selected item. |

An empty-space press clears item selection and remains available to avatar
movement. A selected item keeps precedence where its bounds overlap another
item. Only the primary active pointer is accepted; additional pointers are
counted and ignored until the current claim terminates.

## Application strategies

Applications may add local gestures without reaching into Pixi or attaching
listeners to the Canvas element:

```ts
import {
  CanvasRuntime,
  pointerInteractionPriorities,
  type PointerInteractionStrategy,
} from "@canvas-physics/client/runtime";

const inspect: PointerInteractionStrategy = {
  id: "product-inspect",
  priority: pointerInteractionPriorities.itemEdit + 10,
  claim(sample) {
    if (!sample.world || !isInspectTarget(sample.world)) return undefined;
    beginInspect(sample.world);
    return {
      kind: "inspect",
      move: (next) => next.world && updateInspect(next.world),
      release: (next) => next.world && finishInspect(next.world),
      cancel: () => cancelInspect(),
    };
  },
};

const runtime = new CanvasRuntime({
  // ordinary runtime options...
  pointerInteractions: [inspect],
});
```

Strategy IDs must be non-empty and unique within the runtime, and priorities
must be finite. Registration fails immediately when that contract is invalid.
A strategy receives a frozen sample with client, element-local, and optional
world coordinates; it never receives the mutable DOM event. Its callbacks must
remain quick and must not mutate Canvas state outside public runtime APIs.

An application strategy is presentation/input policy only. It does not bypass
server item ownership, host authority, behavior determinism, or room
authentication. If a strategy throws, the runtime reports a recoverable
`CanvasConsumerError` with source `input` and code
`pointer_interaction_failed`; ownership and later interactions remain usable.

## Lifecycle

The observable phases are `idle`, `pending`, `active`, and `suspended`.
Tap/drag recognizers use `pending` until their movement threshold is crossed.
Loss of capture, browser-window exit, or focus loss suspends the current claim;
a held move resumes it. Release, browser cancellation, a move with the primary
button no longer held, runtime destruction, selection changes, avatar disable,
or strategy disablement is terminal.

The coordinator clears ownership before invoking a terminal callback. A
callback, capture event, or runtime transition therefore cannot produce a
second terminal event or prevent an immediate new grab. Touch remains held even
on browsers that report a zero mouse-button bit for touch moves.

## Diagnostics and limits

`RuntimeDiagnostics.pointer` reports the phase, pointer and strategy IDs,
strategy-defined claim kind, latest local/world point, capture state,
suspension count, ignored secondary pointers, and the last terminal reason.
Diagnostics are observational; do not use them as an input or authorization
source.

Canvas currently coordinates one interaction at a time. Simultaneous
multi-touch gestures such as pinch/rotate require a future multi-pointer
strategy contract rather than attaching a second listener beside the
coordinator.

The conformance matrix lives in
`packages/client/test/pointer-interaction-coordinator.test.ts` and
`packages/client/test/pointer-interaction-routing.test.ts`. It covers priority,
overlap, touch, secondary pointers, capture loss, window exit/re-entry,
cancellation, missing button-up recovery, runtime-driven cancellation,
consumer failure isolation, and exactly-once termination.
