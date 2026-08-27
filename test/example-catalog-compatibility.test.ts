import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ItemDefinition } from "@canvas-physics/core";
import { basketballDefinitions } from "../examples/basketball-arena/src/basketball-content.js";
import { playgroundDefinitions } from "../examples/item-playground/src/content.js";
import { linkedRoomDefinitions } from "../examples/linked-rooms/src/content.js";
import { soccerDefinitions } from "../examples/soccer-lounge/src/soccer-content.js";

const root = resolve(import.meta.dirname, "..");
const examples: Record<string, readonly ItemDefinition[]> = {
  "basketball-arena": basketballDefinitions,
  "item-playground": playgroundDefinitions,
  "linked-rooms": linkedRoomDefinitions,
  "soccer-lounge": soccerDefinitions,
};

describe("example client/server catalog compatibility", () => {
  for (const [example, clientDefinitions] of Object.entries(examples)) {
    it(`${example} keeps every authoritative definition identical to the client`, () => {
      const definitionsDir = resolve(root, "examples", example, "server", "definitions");
      const byIdentity = new Map(
        clientDefinitions.map((definition) => [
          `${definition.definitionId}@${definition.version}`,
          definition,
        ]),
      );
      const serverDefinitions = readdirSync(definitionsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(resolve(definitionsDir, name), "utf8")) as
          ItemDefinition & { configSchema?: unknown });

      expect(serverDefinitions.length).toBeGreaterThan(0);
      for (const serverDefinition of serverDefinitions) {
        const { configSchema: _serverOnlySchema, ...sharedDefinition } = serverDefinition;
        const identity = `${serverDefinition.definitionId}@${serverDefinition.version}`;
        expect(byIdentity.get(identity), `missing client definition ${identity}`)
          .toEqual(sharedDefinition);
      }
    });
  }
});
