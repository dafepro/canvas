import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasSnapshot } from "@canvas-physics/core";
import {
  RapierWorld,
  SimulationKernel,
  crateDefinition,
  rocketCanvas,
  rocketCanvasDefinitions,
  type SimulationResponse,
} from "../src/index.js";

beforeAll(async () => {
  await RapierWorld.load();
}, 30_000);

describe("SimulationKernel host promotion", () => {
  it("keeps the granted snapshot when promotion races asynchronous initialization", async () => {
    const messages: SimulationResponse[] = [];
    const kernel = new SimulationKernel((message) => messages.push(message));
    const snapshot: CanvasSnapshot = {
      schemaVersion: 1,
      canvasId: rocketCanvas.id,
      canvasVersion: rocketCanvas.version,
      sceneRevision: 1,
      hostEpoch: 7,
      checkpointRevision: 41,
      tick: 600,
      capturedAt: new Date().toISOString(),
      normalized: false,
      avatars: [],
      items: [{
        entityId: "durable-crate",
        definitionId: crateDefinition.definitionId,
        definitionVersion: crateDefinition.version,
        ownerUserId: "",
        transform: { x: 40, y: 20, rotation: 0, scale: 1 },
        resolvedConfig: {},
      }],
    };

    kernel.handle({
      type: "init",
      canvas: rocketCanvas,
      definitions: rocketCanvasDefinitions,
      tickRate: 60,
      isHost: false,
    });
    kernel.handle({ type: "setHost", isHost: true, snapshot, wakeFromSleep: false });

    await expect.poll(() => messages.some((message) => message.type === "ready")).toBe(true);
    kernel.handle({
      type: "requestSnapshot",
      final: false,
      sceneRevision: 1,
      hostEpoch: 8,
    });
    await expect.poll(() => messages.some((message) => message.type === "snapshot")).toBe(true);

    const result = messages.findLast(
      (message): message is Extract<SimulationResponse, { type: "snapshot" }> =>
        message.type === "snapshot",
    )!.snapshot;
    expect(result.checkpointRevision).toBe(42);
    expect(result.items.map((item) => item.entityId)).toEqual(["durable-crate"]);
    kernel.stop();
  });
});
