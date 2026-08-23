import type { AssetManifest } from "@canvas-physics/client";

/** Product-owned artwork consumed only through Canvas's public asset contract. */
export const soccerAssets: AssetManifest = {
  schemaVersion: 1,
  id: "soccer-lounge",
  revision: "2026-08-23.4",
  sources: [
    { id: "field-art", src: "/soccer-field.svg", required: true },
    {
      id: "ball-impact-atlas",
      src: "/assets/soccer-ball-impact.png",
      required: true,
    },
    {
      id: "goal-net-art",
      src: "/assets/soccer-goal-net.png",
      required: true,
    },
    {
      id: "player-avatar-art",
      src: "/assets/soccer-player-avatar.png",
      required: true,
    },
  ],
  textures: [
    { id: "soccer-field", sourceId: "field-art" },
    {
      id: "soccer.player.avatar",
      sourceId: "player-avatar-art",
      // Remove the generation padding so the configured world size describes the player.
      frame: { x: 300, y: 0, width: 680, height: 1200 },
    },
    {
      id: "soccer.goal.net",
      sourceId: "goal-net-art",
      // Crop to opaque content so the front post lands exactly on the goal line.
      frame: { x: 121, y: 62, width: 612, height: 1642 },
    },
    {
      id: "soccer.ball.idle",
      sourceId: "ball-impact-atlas",
      frame: { x: 28, y: 45, width: 570, height: 540 },
    },
    {
      id: "soccer.ball.impact",
      sourceId: "ball-impact-atlas",
      frame: { x: 655, y: 45, width: 570, height: 540 },
    },
    {
      id: "soccer.ball.stretch",
      sourceId: "ball-impact-atlas",
      frame: { x: 28, y: 672, width: 570, height: 540 },
    },
    {
      id: "soccer.ball.settle",
      sourceId: "ball-impact-atlas",
      frame: { x: 655, y: 672, width: 570, height: 540 },
    },
  ],
};
