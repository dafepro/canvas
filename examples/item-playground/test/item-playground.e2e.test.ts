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
import { ForceFieldBehavior } from "../src/force-field-behavior.js";
import { GraffitiBehavior } from "../src/graffiti-behavior.js";
import { LiveBouncerBehavior } from "../src/live-bouncer-behavior.js";
import { PairedPortalBehavior } from "../src/paired-portal-behavior.js";
import { ReactiveOrbBehavior } from "../src/reactive-orb-behavior.js";
import { playgroundDefinitions } from "../src/content.js";

const root = resolve(import.meta.dirname, "..");
const authoritativeDefinitionIds = [
  "antigravity-field",
  "black-hole",
  "color-tile",
  "emoji-party",
  "graffiti-text",
  "live-bouncer",
  "paired-portal",
  "photo-card",
  "reactive-orb",
  "system-stamp",
] as const;

let server: Canvasd;
let session: RoomSession | undefined;

describe.skipIf(!goAvailable())("item playground through canvasd", () => {
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

  it("presents the workbench, runs its live behavior, and accepts every authored item", async () => {
    session = new RoomSession({
      roomId: "item-playground-live",
      serverUrl: server.url,
      credentialProvider: async () => devRealtimeCredential("item-smoke", "Item Smoke"),
      definitions: playgroundDefinitions,
      driver: SimulationDriver.local([
        ReactiveOrbBehavior,
        LiveBouncerBehavior,
        PairedPortalBehavior,
        ForceFieldBehavior,
        GraffitiBehavior,
      ]),
    });

    await session.start({ until: "presented" });
    await waitFor("item playground host and system items", () => {
      const ids = new Set(session!.entitiesToDraw(performance.now()).map(({ id }) => id));
      return session!.client.hostLease.isHost &&
        ids.has("room-owned-stamp") &&
        ids.has("always-live-ball");
    });
    expect(session.canvas).toMatchObject({ id: "item-playground-live", version: 3 });

    const ballStart = session.entitiesToDraw(performance.now())
      .find(({ id }) => id === "always-live-ball")!;
    await waitFor("the always-live behavior to move its system ball", () => {
      const ball = session!.entitiesToDraw(performance.now())
        .find(({ id }) => id === "always-live-ball");
      return ball !== undefined && Math.hypot(ball.x - ballStart.x, ball.y - ballStart.y) > 0.2;
    });

    const spawnedIds: string[] = [];
    for (const [index, definitionId] of authoritativeDefinitionIds.entries()) {
      const outcome = await session.spawnItem(definitionId, {
        x: 3 + (index % 5) * 6,
        y: 3 + Math.floor(index / 5) * 6,
      }).settled;
      expect(outcome, definitionId).toMatchObject({
        status: "accepted",
        itemRevision: 1,
        item: { definitionId },
      });
      if (outcome.status === "accepted" && outcome.item) {
        spawnedIds.push(outcome.item.entityId);
      }
    }

    await waitFor("every accepted item to reach canonical presentation", () => {
      const ids = new Set(session!.entitiesToDraw(performance.now()).map(({ id }) => id));
      return spawnedIds.length === authoritativeDefinitionIds.length &&
        spawnedIds.every((id) => ids.has(id));
    });
  }, 45_000);
});
