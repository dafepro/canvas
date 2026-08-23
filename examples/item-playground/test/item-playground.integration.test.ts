import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateCanvasDefinition, type CanvasDefinition } from "@canvas-physics/core";
import { BehaviorTestHarness } from "@canvas-physics/core/testing";
import { validateAssetReferences } from "@canvas-physics/client";
import canvasJson from "../server/canvases/item-playground.json";
import emojiJson from "../server/definitions/emoji-party.json";
import photoJson from "../server/definitions/photo-card.json";
import orbJson from "../server/definitions/reactive-orb.json";
import stampJson from "../server/definitions/system-stamp.json";
import bouncerJson from "../server/definitions/live-bouncer.json";
import colorTileJson from "../server/definitions/color-tile.json";
import { playgroundAssets } from "../src/assets.js";
import {
  playgroundDefinitions,
  playgroundAvatarDefinition,
  reactiveOrbDefinition,
} from "../src/content.js";
import {
  ReactiveOrbBehavior,
  defaultReactiveOrbConfig,
} from "../src/reactive-orb-behavior.js";
import { LiveBouncerBehavior } from "../src/live-bouncer-behavior.js";

const canvas = canvasJson as unknown as CanvasDefinition;

describe("compact item playground", () => {
  it("keeps the independently served scene intentionally small", () => {
    expect(validateCanvasDefinition(canvas)).toEqual({ ok: true });
    expect(canvas.size).toEqual({ width: 36, height: 24 });
    expect(canvas.limits.maxItems).toBeGreaterThanOrEqual(30);
    expect(canvas.systemItems).toEqual([
      expect.objectContaining({
        entityId: "room-owned-stamp",
        definitionId: "system-stamp",
      }),
      expect.objectContaining({
        entityId: "always-live-ball",
        definitionId: "live-bouncer",
      }),
    ]);
  });

  it("keeps client definitions, server contracts, and consumer assets aligned", () => {
    const serverDefinitions = [
      emojiJson,
      photoJson,
      orbJson,
      stampJson,
      bouncerJson,
      colorTileJson,
    ];
    for (const definition of playgroundDefinitions.filter(
      ({ definitionId }) => definitionId !== "avatar",
    )) {
      const server = serverDefinitions.find(
        ({ definitionId }) => definitionId === definition.definitionId,
      );
      expect(server, definition.definitionId).toBeDefined();
      expect(server?.version).toBe(definition.version);
      expect(server?.visual).toEqual(definition.visual);
      expect(server?.defaultConfig).toEqual(definition.defaultConfig);
    }

    expect(validateAssetReferences(playgroundAssets, canvas, playgroundDefinitions)).toEqual([]);
    expect(playgroundAvatarDefinition.visual.spriteId).toBe("playground.avatar.maker");
  });

  it("keeps direct manipulation controls around the selected item", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('class="scale-tools"');
    expect(html).toContain('class="rotate-control rotate-left"');
    expect(html).toContain('class="rotate-control rotate-right"');
    expect(html).toContain('id="more-toggle"');
    expect(html).toContain('id="finish-edit"');
    expect(html).toContain('aria-label="Delete item"');
  });

  it("applies configured color and plays an effect on avatar contact", () => {
    const harness = new BehaviorTestHarness(
      ReactiveOrbBehavior,
      { ...defaultReactiveOrbConfig, theme: "coral" },
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );

    harness.advance();
    expect(harness.host.body(harness.entityId).variant).toBe("coral");

    harness.send({
      type: "contact.enter",
      selfColliderId: "touch",
      other: {
        entityId: "avatar:visitor",
        colliderId: "body",
        kind: "avatar",
        tags: [],
        userId: "visitor",
      },
    }).advance(1, false);

    expect(harness.host.body(harness.entityId).animation).toBe("pulse");
    expect(harness.host.effects).toEqual([
      expect.objectContaining({ effect: "portalFlash", mode: "oneShot" }),
    ]);
    expect(harness.state.activations).toBe(1);
  });

  it("keeps the room-owned demo ball moving without an editor", () => {
    const harness = new BehaviorTestHarness(
      LiveBouncerBehavior,
      { minimumSpeed: 3, velocity: { x: 7, y: 5 } },
      { canvas: { width: 36, height: 24, orientation: "topDown" } },
    );

    harness.advance();
    expect(harness.host.body(harness.entityId).velocity).toEqual({ x: 7, y: 5 });
    harness.host.body(harness.entityId).velocity = { x: 1, y: 0 };
    harness.advance();
    expect(harness.host.body(harness.entityId).velocity).toEqual({ x: 7, y: 5 });
  });
});
