import type { AssetManifest } from "@canvas-physics/client";

export const linkedRoomAssets: AssetManifest = {
  schemaVersion: 1,
  id: "linked-rooms",
  revision: "2026-08-24.1",
  sources: [
    { id: "village-art", src: "/village.svg", required: true },
    { id: "cave-art", src: "/cave.svg", required: true },
    { id: "door-art", src: "/door.svg", required: true },
  ],
  textures: [
    { id: "linked.village", sourceId: "village-art" },
    { id: "linked.cave", sourceId: "cave-art" },
    { id: "linked.door", sourceId: "door-art" },
  ],
};
