import type { AssetManifest } from "@canvas-physics/client";

export const basketballAssets: AssetManifest = {
  schemaVersion: 1,
  id: "basketball-arena",
  revision: "2026-08-25.1",
  sources: [
    { id: "court-art", src: "/assets/basketball-court.png", required: true },
    { id: "ball-art", src: "/assets/basketball-ball.png", required: true },
    { id: "hoop-art", src: "/assets/basketball-hoop.png", required: true },
    { id: "avatar-art", src: "/assets/basketball-avatar.png", required: true },
    { id: "scoreboard-art", src: "/assets/basketball-scoreboard.png", required: true },
  ],
  textures: [
    { id: "basketball.court", sourceId: "court-art" },
    { id: "basketball.ball", sourceId: "ball-art" },
    { id: "basketball.hoop", sourceId: "hoop-art" },
    { id: "basketball.avatar", sourceId: "avatar-art" },
    {
      id: "basketball.scoreboard.teal",
      sourceId: "scoreboard-art",
      frame: { x: 0, y: 0, width: 1086, height: 724 },
    },
    {
      id: "basketball.scoreboard.coral",
      sourceId: "scoreboard-art",
      frame: { x: 1086, y: 0, width: 1086, height: 724 },
    },
  ],
};
