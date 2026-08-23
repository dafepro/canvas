# Reference integration contract

Reference integrations are executable consumer contracts. They show how a
product composes Canvas without moving product rules into the library, and they
must remain useful enough to expose missing extension seams.

## Required shape

Each example:

- lives under `examples/<name>` with its own package, build, test, and run
  commands;
- imports Canvas only through documented package exports;
- owns its canvas definition, authoritative server JSON, behaviors, worker
  entry, art, product UI, and product policy;
- runs against the reference rooms service without modifying that service;
- includes deterministic behavior tests and a production bundle check;
- names every missing generic capability it works around; and
- is eventually verified against clean installs of packed release artifacts.

Examples are not compatibility fixtures. This repository is prerelease, so a
public contract change updates the examples in the same release and removes the
superseded path.

## Soccer lounge reference integration

`examples/soccer-lounge` is the first reference integration and the model for a
Zoomigo enrichment layer. Canvas owns synchronization, host election, physics,
input, rendering, and durable behavior state. The example owns field geometry,
the soccer-ball behavior, score semantics, visual treatment, and lounge UI.

The first runnable slice must prove:

1. A top-down field combines an image with matching collision geometry.
2. A custom worker behavior lets avatars kick a match ball.
3. The ball cannot leave the pitch except through either goal mouth.
4. Entering a goal atomically increments shared score state, stops the ball in
   the goal, and resets it to center after a configured delay.
5. A late joiner derives the same scoreboard from canonical behavior state.

Two requirements depend on generic APIs rather than soccer-specific shortcuts:

- A system-owned room-template item API must create exactly one match ball.
  Until it exists, the example exposes an explicit host/user spawn control.
- A stable participant lifecycle projection must retain offline product members
  after their realtime peer disappears. Zoomigo can then map inactive members
  to a bench without Canvas learning about teams or benches.

The example's SVG overlay is deliberately product-owned. It will adopt the
versioned asset manifest and preload gate when that generic Priority 1 contract
is available.
