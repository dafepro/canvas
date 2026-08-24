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
import { linkedRoomFromSearch, urlForLinkedRoom } from "../src/route-state.js";

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

  it("persists the active room in a reload-safe URL and rejects unknown rooms", () => {
    expect(linkedRoomFromSearch("?room=linked-cave&user=alice")).toBe("linked-cave");
    expect(linkedRoomFromSearch("?room=not-a-real-room")).toBe("linked-village");
    expect(
      urlForLinkedRoom(
        "http://localhost:5176/?autojoin=1&user=alice&room=linked-village",
        "linked-cave",
      ),
    ).toBe("http://localhost:5176/?autojoin=1&user=alice&room=linked-cave");
  });

  it("activates the door when the avatar centre reaches the sprite midpoint", () => {
    const threshold = roomDoorDefinition.colliders.find(({ id }) => id === "threshold")!;
    expect(threshold.shape).toMatchObject({ type: "rect", width: 0.4 });
    const sensorNearEdge = threshold.offset!.x -
      (threshold.shape.type === "rect" ? threshold.shape.width / 2 : 0);
    const avatarRadius = villageCanvas.avatarController!.radius!;
    expect(sensorNearEdge - avatarRadius).toBeCloseTo(0, 5);
  });
});
