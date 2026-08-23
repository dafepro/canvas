import type { AssetManifest } from "@canvas-physics/client";

/** Every texture in this gallery is supplied by the consumer, not the engine. */
export const playgroundAssets: AssetManifest = {
  schemaVersion: 1,
  id: "item-playground",
  revision: "2026-08-23.1",
  sources: [
    { id: "workbench-art", src: "/workbench.svg", required: true },
    { id: "emoji-art", src: "/assets/party-emoji.svg", required: true },
    { id: "photo-art", src: "/assets/photo-card.svg", required: true },
    { id: "orb-mint-art", src: "/assets/orb-mint.svg", required: true },
    { id: "orb-coral-art", src: "/assets/orb-coral.svg", required: true },
    { id: "orb-violet-art", src: "/assets/orb-violet.svg", required: true },
    { id: "orb-pulse-art", src: "/assets/orb-pulse.svg", required: true },
    { id: "stamp-art", src: "/assets/system-stamp.svg", required: true },
  ],
  textures: [
    { id: "playground.workbench", sourceId: "workbench-art" },
    { id: "playground.emoji.party", sourceId: "emoji-art" },
    { id: "playground.photo", sourceId: "photo-art" },
    { id: "playground.orb.mint", sourceId: "orb-mint-art" },
    { id: "playground.orb.coral", sourceId: "orb-coral-art" },
    { id: "playground.orb.violet", sourceId: "orb-violet-art" },
    { id: "playground.orb.pulse", sourceId: "orb-pulse-art" },
    { id: "playground.system.stamp", sourceId: "stamp-art" },
  ],
};
