import type { PointerDragOptions } from "@canvas-physics/client/runtime";

export interface BasketballControlProfile {
  name: "direct-flick" | "direct-stop" | "thumbstick";
  description: string;
  pointer: Omit<PointerDragOptions, "avatarPosition">;
}

export const resolveBasketballControlProfile = (
  params: URLSearchParams,
): BasketballControlProfile => {
  if (params.get("control") === "thumbstick") {
    return {
      name: "thumbstick",
      description: "Thumbstick: drag empty court for continuous velocity control.",
      pointer: {
        mode: "thumbstick",
        deadZonePx: 4,
        fullRangePx: 58,
        flick: false,
      },
    };
  }

  const flick = params.get("flick") !== "0";
  return {
    name: flick ? "direct-flick" : "direct-stop",
    description: flick
      ? "Direct + flick: the player follows your finger and coasts after a fast release."
      : "Direct stop: the player follows your finger and stops on release.",
    pointer: {
      mode: "avatarDrag",
      grabRadiusPx: 38,
      deadZonePx: 4,
      fullRangePx: 58,
      flick: flick
        ? {
            sampleWindowMs: 100,
            minimumSpeedPxPerSecond: 300,
            fullSpeedPxPerSecond: 1_300,
          }
        : false,
    },
  };
};
