import { describe, expect, it, vi } from "vitest";
import { AnimatedSprite, Sprite, Texture } from "pixi.js";
import type { ItemDefinition } from "@canvas-physics/core";
import {
  LoadedAssetBundle,
  pixiAssetLoader,
  type AssetManifest,
} from "../src/assets/index.js";
import { buildEntityDisplay } from "../src/render/entity-display.js";

vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
vi.stubGlobal("cancelAnimationFrame", vi.fn());

const manifest: AssetManifest = {
  schemaVersion: 1,
  id: "render-test",
  revision: "1",
  sources: [{ id: "atlas", src: "/atlas.png", required: true }],
  textures: [
    { id: "ball.idle", sourceId: "atlas" },
    { id: "ball.hot", sourceId: "atlas" },
    { id: "ball.squash", sourceId: "atlas" },
  ],
};

const assets = new LoadedAssetBundle(
  manifest,
  new Map([
    ["ball.idle", Texture.WHITE],
    ["ball.hot", Texture.EMPTY],
    ["ball.squash", Texture.WHITE],
  ]),
  [],
);

const definition: ItemDefinition = {
  definitionId: "ball",
  version: 1,
  displayName: "Ball",
  visual: {
    spriteId: "ball.idle",
    size: { width: 4, height: 3 },
    anchor: { x: 0.4, y: 0.6 },
    variants: { hot: { spriteId: "ball.hot", color: 0xff0000 } },
    animations: {
      kick: {
        frames: ["ball.idle", "ball.squash", "ball.hot"],
        fps: 12,
        loop: false,
      },
    },
  },
  colliders: [],
  persistence: { transform: true, behaviorState: true, onRoomSleep: "pause" },
  complexity: "simple",
};

describe("asset rendering", () => {
  it("crops atlas frames and rejects frames outside the decoded source", () => {
    const cropped = pixiAssetLoader.frame(
      Texture.WHITE,
      { x: 0, y: 0, width: 1, height: 1 },
      "one-pixel",
    );
    expect(cropped.frame).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
    expect(() =>
      pixiAssetLoader.frame(
        Texture.WHITE,
        { x: 0, y: 0, width: Texture.WHITE.width + 1, height: 1 },
        "too-wide",
      ),
    ).toThrow(/exceeds source/);
    cropped.destroy();
  });

  it("renders a variant texture at world size, anchor, and tint", () => {
    const display = buildEntityDisplay(
      {
        id: "ball-1",
        kind: "item",
        definitionId: "ball",
        x: 0,
        y: 0,
        rotation: 0,
        vx: 0,
        vy: 0,
        angularVelocity: 0,
        variant: "hot",
      },
      definition,
      10,
      assets,
    );

    const sprite = display.children[0];
    expect(sprite).toBeInstanceOf(Sprite);
    expect((sprite as Sprite).texture).toBe(Texture.EMPTY);
    expect((sprite as Sprite).width).toBe(40);
    expect((sprite as Sprite).height).toBe(30);
    expect((sprite as Sprite).anchor).toMatchObject({ x: 0.4, y: 0.6 });
    expect((sprite as Sprite).tint).toBe(0xff0000);
  });

  it("plays named atlas animations at the declared rate", () => {
    const display = buildEntityDisplay(
      {
        id: "ball-1",
        kind: "item",
        definitionId: "ball",
        x: 0,
        y: 0,
        rotation: 0,
        vx: 0,
        vy: 0,
        angularVelocity: 0,
        animation: "kick",
      },
      definition,
      5,
      assets,
    );

    const sprite = display.children[0];
    expect(sprite).toBeInstanceOf(AnimatedSprite);
    expect((sprite as AnimatedSprite).totalFrames).toBe(3);
    expect((sprite as AnimatedSprite).animationSpeed).toBe(12 / 60);
    expect((sprite as AnimatedSprite).loop).toBe(false);
    expect((sprite as AnimatedSprite).playing).toBe(true);
    display.destroy({ children: true });
  });

  it("uses the definition placeholder when no declared texture loaded", () => {
    const display = buildEntityDisplay(
      {
        id: "ball-1",
        kind: "item",
        definitionId: "ball",
        x: 0,
        y: 0,
        rotation: 0,
        vx: 0,
        vy: 0,
        angularVelocity: 0,
      },
      { ...definition, visual: { ...definition.visual, spriteId: "missing", placeholder: { shape: "circle", color: 0x123456 } } },
      10,
      assets,
    );

    expect(display.children[0]).not.toBeInstanceOf(Sprite);
  });
});
