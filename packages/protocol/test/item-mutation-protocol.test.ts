import { describe, expect, it } from "vitest";
import {
  ItemEditSessionStatus,
  ItemMutationKind,
  ItemMutationRejectCode,
  channelFor,
  decodeEnvelope,
  encodeEnvelope,
  envelope,
  messageClassOf,
  payloadCase,
} from "../src/index.js";

describe("item mutation protocol", () => {
  it("round-trips a correlated authoritative mutation result", () => {
    const message = envelope("studio", {
      itemMutationResult: {
        clientSessionId: "browser-session",
        mutationId: 7,
        editSessionId: "edit-3",
        accepted: true,
        rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
        message: "",
        sceneRevision: 19,
        itemRevision: 4,
        itemInstanceJson: new TextEncoder().encode('{"entityId":"i1"}'),
        deletedEntityId: "",
        kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
        entityId: "i1",
      },
    });

    const decoded = decodeEnvelope(encodeEnvelope(message));
    expect(decoded.itemMutationResult).toMatchObject({
      clientSessionId: "browser-session",
      mutationId: 7,
      editSessionId: "edit-3",
      accepted: true,
      sceneRevision: 19,
      itemRevision: 4,
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
      entityId: "i1",
    });
    expect(payloadCase(decoded)).toBe("itemMutationResult");
    expect(messageClassOf(decoded)).toBe("durableMutation");
  });

  it("routes disposable previews over realtime and edit control over reliable", () => {
    const preview = envelope("studio", {
      itemEditPreview: {
        clientSessionId: "browser-session",
        editSessionId: "edit-3",
        entityId: "i1",
        previewSequence: 11,
        position: { x: 2, y: 3 },
        rotation: 0.2,
        z: 0,
        scale: 1,
        revert: false,
      },
    });
    const begin = envelope("studio", {
      beginItemEdit: {
        clientSessionId: "browser-session",
        editSessionId: "edit-3",
        entityId: "i1",
        observedItemRevision: 3,
      },
    });
    const result = envelope("studio", {
      itemEditSessionResult: {
        clientSessionId: "browser-session",
        editSessionId: "edit-3",
        entityId: "i1",
        status: ItemEditSessionStatus.ITEM_EDIT_SESSION_ACTIVE,
        rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
        message: "",
        itemRevision: 3,
        leaseExpiresAtUnixMs: 1000,
        itemInstanceJson: new Uint8Array(),
      },
    });

    expect(channelFor(messageClassOf(preview))).toBe("realtime");
    expect(channelFor(messageClassOf(begin))).toBe("reliable");
    expect(payloadCase(result)).toBe("itemEditSessionResult");
  });
});
