import type { AssetManifest } from "@canvas-physics/client";

export const linkedRoomAssets: AssetManifest = {
  schemaVersion: 1,
  id: "linked-rooms",
  revision: "2026-08-24.3",
  sources: [
    { id: "village-art", src: "/village.svg", required: true },
    { id: "cave-art", src: "/cave.svg", required: true },
    { id: "door-art", src: "/door.svg", required: true },
    { id: "pixel-room-art", src: "/pixel-room.png", required: true },
    { id: "open-door-art", src: "/open-door.png", required: true },
    { id: "adventure-ball-art", src: "/adventure-ball.png", required: true },
  ],
  textures: [
    { id: "linked.village", sourceId: "village-art" },
    { id: "linked.cave", sourceId: "cave-art" },
    { id: "linked.door", sourceId: "door-art" },
    { id: "linked.pixelRoom", sourceId: "pixel-room-art" },
    { id: "linked.openDoor", sourceId: "open-door-art" },
    { id: "linked.adventureBall", sourceId: "adventure-ball-art" },
  ],
};
