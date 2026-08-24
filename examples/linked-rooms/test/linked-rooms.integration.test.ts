import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RoomLinkGraph } from "@canvas-physics/core";
import {
  caveCanvas,
  adventureBallDefinition,
  linkedRoomLinks,
  openDoorDefinition,
  pixelRoomCanvas,
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
    expect(json("server/canvases/linked-pixel-room.json")).toEqual(pixelRoomCanvas);
    const serverDefinition = json<Record<string, unknown>>(
      "server/definitions/linked-room-door.json",
    );
    expect(serverDefinition).toMatchObject(roomDoorDefinition);
    expect(json("server/definitions/linked-open-door.json"))
      .toMatchObject(openDoorDefinition);
    expect(json("server/definitions/linked-adventure-ball.json"))
      .toMatchObject(adventureBallDefinition);
  });

  it("places each exact reverse link in its declared origin room", () => {
    const graph = new RoomLinkGraph(linkedRoomLinks);
    for (const canvas of [villageCanvas, caveCanvas, pixelRoomCanvas]) {
      for (const item of canvas.systemItems) {
        const config = item.resolvedConfig as { linkId?: string };
        if (!config.linkId) continue;
        expect(graph.resolve(canvas.id, config.linkId).returnLinkId).toBeTruthy();
      }
      expect(graph.linksFrom(canvas.id)).toHaveLength(canvas.id === "linked-village" ? 2 : 1);
    }
  });

  it("persists the active room in a reload-safe URL and rejects unknown rooms", () => {
    expect(linkedRoomFromSearch("?room=linked-cave&user=alice")).toBe("linked-cave");
    expect(linkedRoomFromSearch("?room=linked-pixel-room&user=alice"))
      .toBe("linked-pixel-room");
    expect(linkedRoomFromSearch("?room=not-a-real-room")).toBe("linked-village");
    expect(
      urlForLinkedRoom(
        "http://localhost:5176/?autojoin=1&user=alice&room=linked-village",
        "linked-cave",
      ),
    ).toBe("http://localhost:5176/?autojoin=1&user=alice&room=linked-cave");
  });

  it("ships generated pixel-room, open-door, and ball assets", () => {
    for (const asset of ["pixel-room.png", "open-door.png", "adventure-ball.png"]) {
      expect(readFileSync(resolve(root, `public/${asset}`)).byteLength).toBeGreaterThan(100_000);
    }
  });

  it("does not kick the ball during a direct room join", () => {
    const spawn = pixelRoomCanvas.spawnPoints[0]!.position;
    const ball = pixelRoomCanvas.systemItems.find(
      ({ entityId }) => entityId === "pixel-room-ball",
    )!.transform;
    const distance = Math.hypot(spawn.x - ball.x, spawn.y - ball.y);
    const kickSensor = adventureBallDefinition.colliders.find(({ id }) => id === "kick")!;
    const kickRadius = kickSensor.shape.type === "circle" ? kickSensor.shape.radius : 0;
    expect(distance).toBeGreaterThan(
      pixelRoomCanvas.avatarController!.radius! + kickRadius,
    );
  });

  it("activates the door when the avatar centre reaches the sprite midpoint", () => {
    const threshold = roomDoorDefinition.colliders.find(({ id }) => id === "threshold")!;
    expect(threshold.shape).toMatchObject({ type: "rect", width: 0.4 });
    const sensorNearEdge = threshold.offset!.x -
      (threshold.shape.type === "rect" ? threshold.shape.width / 2 : 0);
    const avatarRadius = villageCanvas.avatarController!.radius!;
    expect(sensorNearEdge - avatarRadius).toBeCloseTo(0, 5);
  });

  it("makes duplicate-session displacement explicit and recoverable", () => {
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const css = readFileSync(resolve(root, "src/style.css"), "utf8");
    const main = readFileSync(resolve(root, "src/main.ts"), "utf8");

    expect(html).toContain('id="session-blocker"');
    expect(html).toContain('id="take-control"');
    expect(css).toContain(".room-card.session-blocked");
    expect(main).toContain('serverCode === "session_superseded"');
    expect(main).toContain("await displaced?.close()");
  });

  it("hides and disables a traveler while the destination is staged", () => {
    const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
    expect(main).toContain("hideDisabledAvatars: true");
    expect(main).toContain("runtime.setLocalAvatarPresentationHidden(pending)");
    expect(main).toContain("runtime.setAvatarDisabled(pending)");
  });
});
