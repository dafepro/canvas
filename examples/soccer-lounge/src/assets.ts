import type { AssetManifest } from "@canvas-physics/client";

/** Product-owned artwork consumed only through Canvas's public asset contract. */
export const soccerAssets: AssetManifest = {
  schemaVersion: 1,
  id: "soccer-lounge",
  revision: "2026-08-23.1",
  sources: [
    { id: "field-art", src: "/soccer-field.svg", required: true },
    {
      id: "ball-impact-atlas",
      src: "/assets/soccer-ball-impact.png",
      required: true,
    },
  ],
  textures: [
    { id: "soccer-field", sourceId: "field-art" },
    {
      id: "soccer.ball.idle",
      sourceId: "ball-impact-atlas",
      frame: { x: 0, y: 0, width: 627, height: 627 },
    },
    {
      id: "soccer.ball.impact",
      sourceId: "ball-impact-atlas",
      frame: { x: 627, y: 0, width: 627, height: 627 },
    },
    {
      id: "soccer.ball.stretch",
      sourceId: "ball-impact-atlas",
      frame: { x: 0, y: 627, width: 627, height: 627 },
    },
    {
      id: "soccer.ball.settle",
      sourceId: "ball-impact-atlas",
      frame: { x: 627, y: 627, width: 627, height: 627 },
    },
  ],
};
