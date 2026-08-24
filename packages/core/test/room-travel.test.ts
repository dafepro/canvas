import { describe, expect, it } from "vitest";
import {
  ROOM_TRAVEL_EFFECT,
  RoomLinkGraph,
  RoomTravelBehavior,
  defaultRoomTravelConfig,
  type BehaviorContext,
  type ContactEnterEvent,
} from "../src/index.js";

const context = {
  tick: 120,
  ticksFor: (seconds: number) => seconds * 60,
} as BehaviorContext;

const contact = (entityId = "avatar:alice"): ContactEnterEvent => ({
  type: "contact.enter",
  tick: 120,
  self: "door-a",
  selfColliderId: "threshold",
  other: {
    entityId,
    colliderId: "body",
    kind: "avatar",
    tags: [],
    userId: "alice",
  },
});

describe("linked room travel", () => {
  it("emits a reliable room-travel request for the avatar crossing the threshold", () => {
    const result = RoomTravelBehavior.onEvent(
      context,
      { ...defaultRoomTravelConfig, sensorId: "threshold", linkId: "village-to-cave" },
      { transitCount: 0, cooldownUntil: [] },
      contact(),
    );

    expect(result.state).toMatchObject({ transitCount: 1 });
    expect(result.commands).toContainEqual({
      type: "emitEffect",
      target: "avatar:alice",
      effect: ROOM_TRAVEL_EFFECT,
      params: { linkId: "village-to-cave", sourcePortalId: "door-a" },
    });
  });

  it("tracks cooldown independently for each avatar", () => {
    const config = {
      ...defaultRoomTravelConfig,
      sensorId: "threshold",
      linkId: "village-to-cave",
    };
    const first = RoomTravelBehavior.onEvent(
      context,
      config,
      { transitCount: 0, cooldownUntil: [] },
      contact("avatar:alice"),
    );
    const second = RoomTravelBehavior.onEvent(
      context,
      config,
      first.state,
      contact("avatar:bob"),
    );

    expect(second.state.transitCount).toBe(2);
    expect(second.state.cooldownUntil.map(([id]) => id)).toEqual([
      "avatar:alice",
      "avatar:bob",
    ]);
  });

  it("requires every link to have an exact reverse route", () => {
    expect(() => new RoomLinkGraph([
      {
        id: "village-to-cave",
        fromRoomId: "village",
        toRoomId: "cave",
        returnLinkId: "cave-to-village",
      },
    ])).toThrow(/return link/i);

    const graph = new RoomLinkGraph([
      {
        id: "village-to-cave",
        fromRoomId: "village",
        toRoomId: "cave",
        returnLinkId: "cave-to-village",
        arrivalSpawnPointId: "from-village",
      },
      {
        id: "cave-to-village",
        fromRoomId: "cave",
        toRoomId: "village",
        returnLinkId: "village-to-cave",
        arrivalSpawnPointId: "from-cave",
      },
    ]);

    expect(graph.resolve("village", "village-to-cave")).toMatchObject({
      toRoomId: "cave",
      arrivalSpawnPointId: "from-village",
    });
    expect(() => graph.resolve("cave", "village-to-cave")).toThrow(/does not leave room/i);
  });
});
