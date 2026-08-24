import { describe, expect, it, vi } from "vitest";
import {
  ROOM_TRAVEL_EFFECT,
  RoomLinkGraph,
  type EffectEmission,
} from "@canvas-physics/core";
import {
  LinkedRoomNavigator,
  type LinkedRoomHandle,
  type RoomOpenRequest,
} from "../src/index.js";

class FakeRoom implements LinkedRoomHandle {
  readonly avatarEntityId = "avatar:alice";
  activated = false;
  activationCount = 0;
  closed = false;
  departurePending = false;
  departureStates: boolean[] = [];
  failActivation = false;
  failSubscription = false;
  private readonly observers = new Set<(effect: Readonly<EffectEmission>) => void>();

  constructor(readonly roomId: string) {}

  subscribeEffects(observer: (effect: Readonly<EffectEmission>) => void): () => void {
    if (this.failSubscription) throw new Error("subscription failed");
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  activate(): void {
    if (this.failActivation) throw new Error("activation failed");
    this.activated = true;
    this.activationCount++;
  }

  close(): void {
    this.closed = true;
  }

  setDeparturePending(pending: boolean): void {
    this.departurePending = pending;
    this.departureStates.push(pending);
  }

  cross(linkId: string, entityId = this.avatarEntityId): void {
    for (const observer of this.observers) {
      observer({
        tick: 1,
        entityId,
        effect: ROOM_TRAVEL_EFFECT,
        mode: "oneShot",
        params: { linkId, sourcePortalId: "door" },
      });
    }
  }
}

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

describe("LinkedRoomNavigator", () => {
  it("stages a destination, replaces the current room, and returns through its reverse", async () => {
    const opened: RoomOpenRequest[] = [];
    const rooms: FakeRoom[] = [];
    const navigator = new LinkedRoomNavigator({
      graph,
      openRoom: async (request) => {
        opened.push(request);
        const room = new FakeRoom(request.roomId);
        rooms.push(room);
        return room;
      },
    });

    await navigator.start("village");
    rooms[0]!.cross("village-to-cave");
    await navigator.whenIdle();

    expect(navigator.currentRoomId).toBe("cave");
    expect(opened[1]).toEqual({
      roomId: "cave",
      fromRoomId: "village",
      viaLinkId: "village-to-cave",
      arrivalSpawnPointId: "from-village",
    });
    expect(rooms[0]).toMatchObject({ activated: true, closed: true });
    expect(rooms[0]!.departureStates).toEqual([true]);
    expect(rooms[1]).toMatchObject({ activated: true, closed: false });

    await expect(navigator.back()).resolves.toBe(true);
    expect(navigator.currentRoomId).toBe("village");
    expect(rooms[1]!.closed).toBe(true);
    expect(navigator.canGoBack).toBe(false);
  });

  it("ignores another avatar and keeps the origin if opening the destination fails", async () => {
    const origin = new FakeRoom("village");
    const onError = vi.fn();
    const navigator = new LinkedRoomNavigator({
      graph,
      openRoom: async (request) => {
        if (request.roomId === "village") return origin;
        throw new Error("credential denied");
      },
      onError,
    });
    await navigator.start("village");

    origin.cross("village-to-cave", "avatar:bob");
    await navigator.whenIdle();
    expect(navigator.currentRoomId).toBe("village");

    origin.cross("village-to-cave");
    await navigator.whenIdle();
    expect(navigator.currentRoomId).toBe("village");
    expect(origin.closed).toBe(false);
    expect(origin.departureStates).toEqual([true, false]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("closes a room whose initial activation fails", async () => {
    const room = new FakeRoom("village");
    room.failActivation = true;
    const navigator = new LinkedRoomNavigator({
      graph,
      openRoom: async () => room,
    });

    await expect(navigator.start("village")).rejects.toThrow("activation failed");
    expect(room.closed).toBe(true);
    expect(navigator.currentRoomId).toBeUndefined();
  });

  it("rolls presentation back to the origin if destination installation fails", async () => {
    const origin = new FakeRoom("village");
    const destination = new FakeRoom("cave");
    destination.failSubscription = true;
    const onError = vi.fn();
    const navigator = new LinkedRoomNavigator({
      graph,
      openRoom: async ({ roomId }) => roomId === "village" ? origin : destination,
      onError,
    });
    await navigator.start("village");

    origin.cross("village-to-cave");
    await navigator.whenIdle();

    expect(navigator.currentRoomId).toBe("village");
    expect(origin).toMatchObject({ closed: false, activationCount: 2 });
    expect(destination.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "subscription failed" }));
  });

  it("isolates consumer callbacks from the committed room transition", async () => {
    const rooms: FakeRoom[] = [];
    const onError = vi.fn();
    const navigator = new LinkedRoomNavigator({
      graph,
      openRoom: async ({ roomId }) => {
        const room = new FakeRoom(roomId);
        rooms.push(room);
        return room;
      },
      onChanged: () => {
        throw new Error("consumer callback failed");
      },
      onError,
    });

    await navigator.start("village");
    rooms[0]!.cross("village-to-cave");
    await navigator.whenIdle();

    expect(navigator.currentRoomId).toBe("cave");
    expect(rooms[0]!.closed).toBe(true);
    expect(rooms[1]!.closed).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "consumer callback failed" }),
    );
  });
});
