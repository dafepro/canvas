import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RapierWorld,
  RoomSession,
  SimulationDriver,
  crateDefinition,
  rocketCanvasDefinitions,
} from "../src/index.js";
import {
  createCanvasdDataDir,
  goAvailable,
  startCanvasd,
  waitFor,
  type Canvasd,
} from "./support/canvasd.js";

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

  it("restores the committed scene after the service process restarts", async () => {
    const dataDir = createCanvasdDataDir();
    let restarted: Canvasd | undefined;
    let reader: RoomSession | undefined;
    const first = await startCanvasd({ dataDir });
    const writer = new RoomSession({
      canvasId: "rocket-canvas",
      serverUrl: first.url,
      userId: "restart-owner",
      displayName: "restart-owner",
      definitions: rocketCanvasDefinitions,
      driver: SimulationDriver.local(),
    });
    try {
      await writer.start();
      await waitFor("restart writer to host", () => writer.client.isHost && writer.tick > 30);
      writer.spawnItem(crateDefinition.definitionId, { x: 44, y: 20 });
      await waitFor("restart writer to hold the crate", () =>
        writer.entitiesToDraw(performance.now()).some((entity) => entity.kind === "item"),
      );
      await writer.stopGracefully(1_000);
      first.stop();

      restarted = await startCanvasd({ dataDir });
      reader = new RoomSession({
        canvasId: "rocket-canvas",
        serverUrl: restarted.url,
        userId: "restart-reader",
        displayName: "restart-reader",
        definitions: rocketCanvasDefinitions,
        driver: SimulationDriver.local(),
      });
      await reader.start();
      await waitFor("the restarted service to restore the crate", () =>
        reader.entitiesToDraw(performance.now()).some(
          (entity) => entity.kind === "item" && entity.definitionId === crateDefinition.definitionId,
        ),
      );
      reader.stop();
    } finally {
      writer.stop();
      reader?.stop();
      first.stop();
      restarted?.stop();
    }
  }, 120_000);
});
