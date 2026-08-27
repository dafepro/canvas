import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import {
  HostControlKind,
  ItemEditSessionStatus,
  ItemMutationKind,
  ItemMutationRejectCode,
  toJsonBytes,
  type RoomEnvelope,
} from "@canvas-physics/protocol";
import { rocketCanvas } from "../src/definitions/rocket-canvas.js";
import { RoomClient } from "../src/net/room-client.js";
import {
  emptyTraffic,
  type JoinDescriptor,
  type RoomTransport,
  type TransportStatus,
} from "../src/net/transport.js";

class JsonBoundaryTransport implements RoomTransport {
  status: TransportStatus = "open";
  readonly traffic = emptyTraffic();
  private readonly messages = new Set<(message: RoomEnvelope) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {}
  sendReliable(): void {}
  sendRealtime(): void {}
  onMessage(handler: (message: RoomEnvelope) => void): () => void {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }
  onStatus(): () => void { return () => {}; }
  close(): void { this.status = "closed"; }
  deliver(message: Partial<RoomEnvelope>): void {
    const envelope: RoomEnvelope = {
      roomId: "team-lounge",
      hostEpoch: 1,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      ...message,
    };
    for (const handler of this.messages) handler(envelope);
  }
}

const join = (transport: JsonBoundaryTransport): RoomClient => {
  const client = new RoomClient({
    transport,
    join: { roomId: "team-lounge", serverUrl: "https://rooms.example.test" },
  });
  transport.deliver({
    joinAccepted: {
      clientId: "client-1",
      userId: "alice",
      displayName: "Alice",
      sceneRevision: 3,
      hostEpoch: 1,
      hostClientId: "other-host",
      canvasDefinitionJson: toJsonBytes(rocketCanvas),
      snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
      roomWasSleeping: false,
      tickRate: 60,
      canvasId: rocketCanvas.id,
    },
  });
  return client;
};

describe("RoomClient JSON boundaries", () => {
  it("rejects a malformed host snapshot without changing the lease", () => {
    const transport = new JsonBoundaryTransport();
    const client = join(transport);
    const priorLease = client.hostLease;
    const errors: [string, string][] = [];
    const granted = vi.fn();
    client.on("error", (code, message) => errors.push([code, message]));
    client.on("hostGranted", granted);

    expect(() => transport.deliver({
      hostEpoch: 2,
      hostControl: {
        kind: HostControlKind.HOST_CONTROL_GRANTED,
        hostClientId: "client-1",
        hostEpoch: 2,
        snapshotJson: new TextEncoder().encode("{"),
        reason: "election",
        eligible: true,
        leaseExpiresAtUnixMs: 1,
      },
    })).not.toThrow();

    expect(errors[0]?.[0]).toBe("malformed_host_snapshot");
    expect(granted).not.toHaveBeenCalled();
    expect(client.hostLease).toBe(priorLease);
  });

  it("rejects malformed mutation JSON before changing revision or notifying handlers", () => {
    const transport = new JsonBoundaryTransport();
    const client = join(transport);
    const errors: string[] = [];
    const mutation = vi.fn();
    const edit = vi.fn();
    client.on("error", (code) => errors.push(code));
    client.on("itemMutationResult", mutation);
    client.on("itemEditSessionResult", edit);

    expect(() => transport.deliver({
      itemMutationResult: {
        clientSessionId: "browser",
        mutationId: 1,
        editSessionId: "",
        accepted: true,
        rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
        message: "",
        sceneRevision: 9,
        itemRevision: 2,
        itemInstanceJson: new TextEncoder().encode("{"),
        deletedEntityId: "",
        kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
        entityId: "rocket-1",
      },
    })).not.toThrow();
    expect(() => transport.deliver({
      itemEditSessionResult: {
        clientSessionId: "browser",
        editSessionId: "edit-1",
        entityId: "rocket-1",
        status: ItemEditSessionStatus.ITEM_EDIT_SESSION_ACTIVE,
        rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
        message: "",
        itemRevision: 2,
        leaseExpiresAtUnixMs: 1,
        itemInstanceJson: new TextEncoder().encode("{"),
      },
    })).not.toThrow();

    expect(errors).toEqual(["malformed_item_mutation_result", "malformed_item_edit_result"]);
    expect(client.durableRevision.sceneRevision).toBe(3);
    expect(mutation).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("rejects malformed canonical JSON before notifying runtime handlers", () => {
    const transport = new JsonBoundaryTransport();
    const client = join(transport);
    const errors: string[] = [];
    const effects = vi.fn();
    const states = vi.fn();
    client.on("error", (code) => errors.push(code));
    client.on("effect", effects);
    client.on("fullState", states);

    expect(() => transport.deliver({
      effectEvent: {
        entityId: "rocket-1",
        effect: "spark",
        mode: "oneShot",
        paramsJson: new TextEncoder().encode("{"),
      },
    })).not.toThrow();
    expect(() => transport.deliver({
      fullState: {
        sceneRevision: 3,
        tickRate: 60,
        avatars: [],
        entities: [{
          entityId: "rocket-1",
          quantizedTransform: undefined,
          lastProcessedInputSequence: 0,
          spriteVariant: "",
          spriteAnimation: "",
          animationEpoch: 0,
          behaviorStateJson: new TextEncoder().encode("{"),
          quarantined: false,
          definitionId: "rocket",
          disabled: false,
          teleportEpoch: 0,
          respawning: false,
        }],
      },
    })).not.toThrow();

    expect(errors).toEqual(["malformed_effect", "malformed_behavior_state"]);
    expect(effects).not.toHaveBeenCalled();
    expect(states).not.toHaveBeenCalled();
  });
});
