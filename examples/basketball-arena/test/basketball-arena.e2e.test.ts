import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RapierWorld,
  RoomSession,
  SimulationDriver,
  devRealtimeCredential,
} from "@canvas-physics/client";
import {
  goAvailable,
  startCanvasd,
  waitFor,
  type Canvasd,
} from "../../../packages/client/test/support/canvasd.js";
import { basketballDefinitions } from "../src/basketball-content.js";
import { BasketballBehavior } from "../src/basketball-behavior.js";

const root = resolve(import.meta.dirname, "..");
let server: Canvasd;
let session: RoomSession | undefined;

describe.skipIf(!goAvailable())("basketball arena through canvasd", () => {
  beforeAll(async () => {
    await RapierWorld.load();
  }, 120_000);

  beforeEach(async () => {
    server = await startCanvasd({
      canvasesDir: resolve(root, "server/canvases"),
      definitionsDir: resolve(root, "server/definitions"),
    });
  }, 120_000);

  afterEach(() => {
    session?.stop();
    session = undefined;
    server?.stop();
  });

  it("boots the configured game ball and both mirrored hoops", async () => {
    session = new RoomSession({
      roomId: "basketball-arena",
      serverUrl: server.url,
      credentialProvider: async () => devRealtimeCredential("e2e-baller", "E2E Baller"),
      definitions: basketballDefinitions,
      driver: SimulationDriver.local([BasketballBehavior]),
    });

    await session.start();
    await session.whenReady();
    await waitFor(
      "basketball arena system items and initial score",
      () => {
        const entities = session!.entitiesToDraw(performance.now());
        const ids = new Set(entities.map(({ id }) => id));
        return session!.client.isHost &&
          ids.has("basketball-game-ball") &&
          ids.has("left-basketball-hoop") &&
          ids.has("right-basketball-hoop");
      },
    );

    expect(session.canvas).toMatchObject({
      id: "basketball-arena",
      backgroundAssetId: "basketball.court",
      systemItems: expect.any(Array),
    });
  }, 30_000);
});
