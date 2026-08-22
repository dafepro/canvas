import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RapierWorld,
  RoomSession,
  SimulationDriver,
  crateDefinition,
  rocketCanvasDefinitions,
} from "../src/index.js";
import { goAvailable, startCanvasd, waitFor, type Canvasd } from "./support/canvasd.js";

interface CanvasResponse {
  awake: boolean;
  snapshot?: {
    normalized?: boolean;
    items?: { definitionId?: string }[];
  };
}

describe.skipIf(!goAvailable())("graceful room sleep through canvasd", () => {
  let server: Canvasd;

  beforeAll(async () => {
    await RapierWorld.load();
    server = await startCanvasd();
  }, 120_000);

  afterAll(() => {
    server?.stop();
  });

  it("persists the last host's normalized final checkpoint", async () => {
    const room = new RoomSession({
      canvasId: "rocket-canvas",
      serverUrl: server.url,
      userId: "alice",
      displayName: "alice",
      definitions: rocketCanvasDefinitions,
      driver: SimulationDriver.local(),
    });
    await room.start();
    await waitFor(
      "the sole host and its presence",
      () => room.client.isHost && room.tick > 30 && room.diagnostics().peers === 1,
    );

    room.spawnItem(crateDefinition.definitionId, { x: 40, y: 20 });
    await waitFor(
      "the host to simulate the durable crate",
      () => room.entitiesToDraw(performance.now()).some((entity) => entity.kind === "item"),
    );
    await room.stopGracefully(1_000);

    let stored: CanvasResponse | undefined;
    await waitFor(
      "canvasd to persist a normalized sleeping snapshot",
      async () => {
        const response = await fetch(`${server.url}/v1/canvases/rocket-canvas`);
        stored = (await response.json()) as CanvasResponse;
        return stored.awake === false && stored.snapshot?.normalized === true;
      },
      10_000,
    );

    expect(stored?.snapshot?.items).toEqual([
      expect.objectContaining({ definitionId: crateDefinition.definitionId }),
    ]);
  }, 90_000);
});
