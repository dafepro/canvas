import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RapierWorld,
  RoomSession,
  SimulationDriver,
  devRealtimeCredential,
  type BehaviorStateSnapshot,
} from "@canvas-physics/client";
import {
  goAvailable,
  startCanvasd,
  waitFor,
  type Canvasd,
} from "../../../packages/client/test/support/canvasd.js";
import { SoccerBallBehavior, type SoccerBallState } from "../src/soccer-ball-behavior.js";
import { soccerDefinitions } from "../src/soccer-content.js";

const root = resolve(import.meta.dirname, "..");
let server: Canvasd;
let session: RoomSession | undefined;

describe.skipIf(!goAvailable())("soccer lounge through canvasd", () => {
  beforeAll(async () => {
    await RapierWorld.load();
  }, 120_000);

  beforeEach(async () => {
    server = await startCanvasd({
      canvasesDir: resolve(root, "server/canvases"),
      definitionsDir: resolve(root, "server/definitions"),
    });
  }, 120_000);

  afterEach(async () => {
    session?.stop();
    session = undefined;
    await server?.stopAndWait();
  });

  it("presents the exact field catalog and initializes the scoring behavior", async () => {
    let behavior: BehaviorStateSnapshot | undefined;
    session = new RoomSession({
      roomId: "soccer-lounge",
      serverUrl: server.url,
      credentialProvider: async () => devRealtimeCredential("soccer-smoke", "Soccer Smoke"),
      definitions: soccerDefinitions,
      driver: SimulationDriver.local([SoccerBallBehavior]),
    });
    session.subscribeBehaviorState((snapshot) => { behavior = snapshot; });

    await session.start({ until: "presented" });
    await waitFor("soccer system items and behavior state", () => {
      const ids = new Set(session!.entitiesToDraw(performance.now()).map(({ id }) => id));
      return session!.client.hostLease.isHost &&
        ids.has("match-ball") &&
        ids.has("left-goal") &&
        ids.has("right-goal") &&
        behavior?.states.some(({ entityId }) => entityId === "match-ball") === true;
    });

    expect(session.canvas).toMatchObject({ id: "soccer-lounge", version: 7 });
    const state = behavior!.states.find(({ entityId }) => entityId === "match-ball")!
      .state as SoccerBallState;
    expect(state).toMatchObject({
      phase: "playing",
      homeScore: 0,
      awayScore: 0,
      kickCount: 0,
    });
  }, 30_000);
});
