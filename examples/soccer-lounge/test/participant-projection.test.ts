import { describe, expect, it } from "vitest";
import type { CanvasDefinition } from "@canvas-physics/core";
import type { ParticipantPresence } from "@canvas-physics/client/runtime";
import soccerCanvasJson from "../server/canvases/soccer-lounge.json";
import { projectSoccerParticipantAvatar } from "../src/participant-projection.js";

const canvas = soccerCanvasJson as unknown as CanvasDefinition;
const participant = (status: ParticipantPresence["status"]): ParticipantPresence => ({
  participantId: "player-7",
  userId: "player-7",
  displayName: "Player 7",
  connectionId: status === "disconnected" ? undefined : "socket-9",
  avatarEntityId: "avatar:player-7",
  status,
  isHost: false,
  hostEligible: status !== "disconnected",
});

describe("soccer participant projection", () => {
  it.each(["inactive", "disconnected"] as const)(
    "moves a %s participant to a deterministic bench slot",
    (status) => {
      const projection = projectSoccerParticipantAvatar(participant(status), {
        canvas,
        previousStatus: "active",
      });
      expect(projection?.position.y).toBe(74);
      expect(projection?.position.x).toBeGreaterThanOrEqual(44);
      expect(projection?.position.x).toBeLessThanOrEqual(76);
    },
  );

  it("returns a reactivated participant to a playable team spawn", () => {
    const projection = projectSoccerParticipantAvatar(participant("active"), {
      canvas,
      previousStatus: "disconnected",
    });
    expect([42, 78]).toContain(projection?.position.x);
    expect(projection?.position.y).toBeGreaterThanOrEqual(30);
    expect(projection?.position.y).toBeLessThanOrEqual(42);
  });

  it("does not override an initial active spawn", () => {
    expect(
      projectSoccerParticipantAvatar(participant("active"), { canvas }),
    ).toBeUndefined();
  });
});
