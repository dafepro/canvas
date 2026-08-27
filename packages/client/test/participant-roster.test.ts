import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import type { Peer } from "@canvas-physics/protocol";
import { rocketCanvas } from "../src/definitions/rocket-canvas.js";
import { ParticipantRoster } from "../src/runtime/session/participant-roster.js";
import type { RenderEntity } from "../src/simulation/messages.js";

const peer = (clientId: string, userId: string, isHost = false): Peer => ({
  clientId,
  userId,
  displayName: userId,
  isHost,
  hostEligible: true,
});

const avatar = (userId: string, disabled = false): RenderEntity => ({
  id: `avatar:${userId}`,
  kind: "avatar",
  definitionId: "avatar",
  userId,
  x: 10,
  y: 20,
  rotation: 0,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
  disabled,
});

describe("ParticipantRoster", () => {
  it("retains one stable tombstone while replacing an ephemeral connection", () => {
    const roster = new ParticipantRoster();
    roster.updatePresence([peer("c-1", "alice", true)]);
    roster.updatePresence([]);
    expect(roster.snapshot.participants).toEqual([
      expect.objectContaining({
        participantId: "alice",
        connectionId: undefined,
        status: "disconnected",
      }),
    ]);

    roster.updatePresence([peer("c-2", "alice", false)]);
    expect(roster.snapshot.participants).toHaveLength(1);
    expect(roster.snapshot.participants[0]).toMatchObject({
      participantId: "alice",
      connectionId: "c-2",
      status: "active",
    });
  });

  it("projects lifecycle changes once and preserves validated avatar positions", () => {
    const roster = new ParticipantRoster({
      projectAvatar: (participant) =>
        participant.status === "inactive" ? { position: { x: 90, y: 5 } } : undefined,
    });
    roster.updatePresence([peer("c-a", "alice", true), peer("c-b", "bob")]);
    roster.observeCanonical([avatar("alice"), avatar("bob", true)]);
    const hostAvatarIds = new Set(["avatar:alice"]);

    const first = roster.reconcileHostAvatars({
      canvas: rocketCanvas,
      hostAvatarIds,
      spawnPosition: () => ({ x: 4, y: 4 }),
    });
    expect(first).toContainEqual(expect.objectContaining({
      type: "addAvatar",
      spawn: expect.objectContaining({ entityId: "avatar:bob" }),
    }));
    expect(first).toContainEqual({
      type: "setAvatarLifecycle",
      entityId: "avatar:bob",
      disabled: true,
      position: { x: 90, y: 5 },
    });
    expect(roster.reconcileHostAvatars({
      canvas: rocketCanvas,
      hostAvatarIds,
      spawnPosition: () => ({ x: 4, y: 4 }),
    })).toEqual([]);

    const snapshot = emptySnapshot(rocketCanvas.id, rocketCanvas.version);
    snapshot.avatars.push({
      entityId: "avatar:bob",
      userId: "bob",
      position: { x: 33, y: 44 },
    });
    roster.loadSnapshotPositions(snapshot);
    expect(roster.spawnPosition("avatar:bob", () => ({ x: 1, y: 1 }))).toEqual({
      x: 33,
      y: 44,
    });
  });

  it("isolates projection failures and falls back to the ordinary spawn", () => {
    const errors: unknown[] = [];
    const roster = new ParticipantRoster({
      projectAvatar: () => {
        throw new Error("broken product projection");
      },
      onProjectionError: (cause) => errors.push(cause),
    });
    roster.updatePresence([peer("c-a", "alice", true)]);

    expect(() => roster.reconcileHostAvatars({
      canvas: rocketCanvas,
      hostAvatarIds: new Set(),
      spawnPosition: () => ({ x: 4, y: 5 }),
    })).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(roster.reconcileHostAvatars({
      canvas: rocketCanvas,
      hostAvatarIds: new Set(),
      spawnPosition: () => ({ x: 4, y: 5 }),
    })[0]).toMatchObject({
      type: "addAvatar",
      spawn: { position: { x: 4, y: 5 } },
    });
  });
});
