# Canvas 0.6.1

Canvas 0.6.1 adds a renderer-local `projectEntityVisual` hook to the Pixi scene
options. Consumers can select a declared sprite variant or tint from immutable
render-entity identity without changing simulation state, snapshots, or the
wire protocol. This supports participant-specific artwork while retaining
Canvas interpolation and the single Pixi render loop.

The release does not change protocol version 8, durable data, simulation,
authority, or server behavior.
