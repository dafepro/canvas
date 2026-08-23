import { describe, expect, it } from "vitest";
import { playerStarCount } from "../src/player-overlay.js";

describe("soccer player overlay", () => {
  it("assigns each stable participant a deterministic one-to-five star crown", () => {
    const first = playerStarCount("participant-alice");
    expect(first).toBe(playerStarCount("participant-alice"));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(5);

    const sample = Array.from({ length: 20 }, (_, index) =>
      playerStarCount(`participant-${index}`));
    expect(new Set(sample).size).toBe(5);
  });
});
