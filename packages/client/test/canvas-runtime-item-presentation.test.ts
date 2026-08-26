import type { RenderEntity } from "../src/simulation/messages.js";
import { CanvasRuntime } from "../src/runtime/canvas-runtime.js";
import { SimulationDriver } from "../src/simulation/driver.js";
import { describe, expect, it, vi } from "vitest";

const stamp = (): RenderEntity => ({
  id: "stamp-1",
  kind: "item",
  definitionId: "stamp",
  userId: "player-1",
  ownerUserId: "player-1",
  x: 12,
  y: 18,
  rotation: 0,
  scale: 1,
  z: 0,
  sleeping: false,
  disabled: false,
  respawning: false,
  resolvedConfig: {},
});

describe("CanvasRuntime item presentation", () => {
  it("holds product-triggered previews and partial commits until canonical state catches up", () => {
    const runtime = new CanvasRuntime({
      roomId: "presentation-test",
      serverUrl: "ws://unused.test",
      credentialProvider: async () => "unused-token",
      mount: {} as HTMLElement,
      definitions: [],
      driver: SimulationDriver.local(),
    });
    const presentation = Reflect.get(runtime, "editPresentation") as {
      preview(entityId: string, transform: unknown): void;
      commit(entityId: string, transform: unknown): void;
    };
    const preview = vi.spyOn(presentation, "preview");
    const commit = vi.spyOn(presentation, "commit");
    Reflect.set(runtime, "latestEntities", [stamp()]);

    runtime.transformItem(
      "stamp-1",
      { x: 12, y: 18, rotation: Math.PI / 12, scale: 1, z: 0 },
      true,
    );
    expect(preview).toHaveBeenLastCalledWith("stamp-1", {
      x: 12,
      y: 18,
      rotation: Math.PI / 12,
      scale: 1,
      z: 0,
    });

    runtime.scaleItem("stamp-1", 1.1);
    expect(commit).toHaveBeenLastCalledWith(
      "stamp-1",
      expect.objectContaining({ x: 12, y: 18, scale: 1.1 }),
    );
  });
});
