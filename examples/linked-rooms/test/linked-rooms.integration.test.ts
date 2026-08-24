import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RoomLinkGraph } from "@canvas-physics/core";
import {
  caveCanvas,
  linkedRoomLinks,
  roomDoorDefinition,
  villageCanvas,
} from "../src/content.js";

const root = resolve(import.meta.dirname, "..");
const json = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;

describe("linked rooms reference integration", () => {
  it("keeps browser and server room content identical", () => {
    expect(json("server/canvases/linked-village.json")).toEqual(villageCanvas);
    expect(json("server/canvases/linked-cave.json")).toEqual(caveCanvas);
    const serverDefinition = json<Record<string, unknown>>(
      "server/definitions/linked-room-door.json",
    );
    expect(serverDefinition).toMatchObject(roomDoorDefinition);
  });

  it("places each exact reverse link in its declared origin room", () => {
    const graph = new RoomLinkGraph(linkedRoomLinks);
    for (const canvas of [villageCanvas, caveCanvas]) {
      for (const item of canvas.systemItems) {
        const config = item.resolvedConfig as { linkId: string };
        expect(graph.resolve(canvas.id, config.linkId).returnLinkId).toBeTruthy();
      }
      expect(graph.linksFrom(canvas.id)).toHaveLength(1);
    }
  });
});
