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
- is verified against clean installs of packed release artifacts.

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
4. Entering a goal atomically increments shared score state while ordinary
   physics continues through a high-damping net region and rear backstop, then
   resets the ball to center after a configured delay.
5. A late joiner derives the same scoreboard from canonical behavior state.

The stable participant lifecycle projection retains identities after their
realtime connection disappears. The generic host hook disables their avatar
and delegates only placement; the soccer integration maps inactive and
disconnected members to deterministic bench slots without Canvas learning
about teams or benches.

The product-owned SVG field and generated ball atlas are loaded through the
versioned asset manifest and preload gate. The field texture is decorative;
the independently defined static colliders and goal sensors remain the
authoritative gameplay geometry. The hard-kick atlas animation is started by
the consumer behavior and synchronized by Canvas's generic animation channel.
Two immutable goal system items reuse one transparent net texture, with the
opposing goal expressed by a 180-degree item transform. Net drag, score zones,
and rear boundaries remain canvas configuration rather than renderer logic.

With `?overlay=1`, the opt-in DOM `Match ball` marker uses the bounded
overlay-projection subscription at 10 Hz. It demonstrates that a product can
align HTML with an interpolated entity without reaching into Pixi, observing
every render frame, or retaining mutable renderer state. It stays out of the
normal lounge UI.

The canvas definition's `systemItems` materializes exactly one match ball on a
new room. System items have no participant owner and reject participant move,
configuration, rotation, and delete commands.
