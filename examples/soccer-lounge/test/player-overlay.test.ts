import { describe, expect, it } from "vitest";
import {
  playerOverlayGeometry,
  playerStarCount,
} from "../src/player-overlay.js";

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

  it("lays stars on a symmetric upper collider arc and the name below the sprite", () => {
    const geometry = playerOverlayGeometry(5, 5);

    expect(geometry.stars).toHaveLength(5);
    expect(geometry.stars.map(({ x }) => x)).toEqual([
      expect.closeTo(-geometry.stars[4]!.x, 5),
      expect.closeTo(-geometry.stars[3]!.x, 5),
      expect.closeTo(0, 5),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(geometry.stars.every(({ y }) => y < 0)).toBe(true);
    expect(geometry.stars[2]!.y).toBeLessThan(geometry.stars[0]!.y);
    expect(geometry.nameOffsetY).toBeGreaterThan(0);
  });

  it("centers a single star directly above the avatar collider", () => {
    expect(playerOverlayGeometry(1, 4).stars[0]).toMatchObject({
      x: expect.closeTo(0, 5),
      y: expect.any(Number),
      rotationDegrees: expect.closeTo(0, 5),
    });
    expect(playerOverlayGeometry(1, 4).stars[0]!.y).toBeLessThan(0);
  });
});
