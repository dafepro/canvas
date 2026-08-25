import { describe, expect, it } from "vitest";
import {
  ReplicationTimeline,
  type CanonicalStateSnapshot,
} from "../src/runtime/session/replication-timeline.js";
import type { RenderEntity } from "../src/simulation/messages.js";

const avatar = (
  x: number,
  sequence = 0,
  id = "avatar:alice",
): RenderEntity => ({
  id,
  kind: "avatar",
  definitionId: "avatar",
  userId: id.slice("avatar:".length),
  x,
  y: 10,
  rotation: 0,
  vx: 0,
  vy: 0,
  angularVelocity: 0,
  lastProcessedInputSequence: sequence,
});

describe("ReplicationTimeline", () => {
  it("publishes frozen complete snapshots after encoding and decoding a keyframe", () => {
    const host = new ReplicationTimeline({ sceneRevision: () => 7 });
    host.acceptHostFrame(30, [avatar(12)]);
    const packet = host.encodeHostFrame(true);

    const peer = new ReplicationTimeline({ sceneRevision: () => 7 });
    const snapshots: CanonicalStateSnapshot[] = [];
    peer.subscribeCanonical((snapshot) => snapshots.push(snapshot));
    peer.acceptFullState({
      entities: packet.entities,
      avatars: [{
        entityId: "avatar:alice",
        clientId: "c-alice",
        userId: "alice",
        displayName: "Alice",
      }],
      sceneRevision: 7,
      tickRate: 60,
    }, 30);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      tick: 30,
      sceneRevision: 7,
      entities: [{ id: "avatar:alice", userId: "alice", x: 12 }],
    });
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(Object.isFrozen(snapshots[0]!.entities[0])).toBe(true);
  });

  it("reconciles against the prediction for the acknowledged sequence", () => {
    const timeline = new ReplicationTimeline({ sceneRevision: () => 0 });
    timeline.acceptLocalPredictionFrame(1, [avatar(10, 1)], "avatar:alice");
    timeline.acceptLocalPredictionFrame(2, [avatar(20, 2)], "avatar:alice");

    const canonical = new ReplicationTimeline({ sceneRevision: () => 0 });
    canonical.acceptHostFrame(3, [avatar(12, 1)]);
    timeline.acceptFullState({
      entities: canonical.encodeHostFrame(true).entities,
      avatars: [{
        entityId: "avatar:alice",
        clientId: "c-alice",
        userId: "alice",
        displayName: "Alice",
      }],
      sceneRevision: 0,
      tickRate: 60,
    }, 3);

    const frame = timeline.frame(1_000, "avatar:alice", false);
    expect(frame.find(({ id }) => id === "avatar:alice")?.x).toBeGreaterThan(20);
    expect(timeline.diagnostics.acknowledgedInputSequence).toBe(1);
    expect(timeline.diagnostics.predictionHistoryDepth).toBe(1);
  });

  it("resets every epoch-scoped buffer, prediction, and host delta baseline", () => {
    const timeline = new ReplicationTimeline({ sceneRevision: () => 0 });
    timeline.acceptHostFrame(1, [avatar(1, 1)]);
    timeline.encodeHostFrame(true);
    timeline.acceptLocalPredictionFrame(2, [avatar(2, 2)], "avatar:alice");

    timeline.resetEpoch(9);

    expect(timeline.diagnostics).toMatchObject({
      hostEpoch: 9,
      interpolationDepth: 0,
      predictionHistoryDepth: 0,
      acknowledgedInputSequence: 0,
    });
    expect(timeline.encodeHostFrame(false)).toMatchObject({
      entities: [expect.objectContaining({ entityId: "avatar:alice" })],
      removedEntityIds: [],
    });
  });

  it("encodes only changed entities between keyframes", () => {
    const timeline = new ReplicationTimeline({ sceneRevision: () => 0 });
    timeline.acceptHostFrame(1, [avatar(1)]);
    expect(timeline.encodeHostFrame(true).entities).toHaveLength(1);
    expect(timeline.encodeHostFrame(false).entities).toHaveLength(0);

    timeline.acceptHostFrame(2, [avatar(2)]);
    expect(timeline.encodeHostFrame(false).entities).toHaveLength(1);
  });
});
