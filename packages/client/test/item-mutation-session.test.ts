import { describe, expect, it } from "vitest";
import { emptySnapshot, type SnapshotItem, type Transform } from "@canvas-physics/core";
import {
  ItemEditSessionStatus,
  ItemMutationKind,
  ItemMutationRejectCode,
  type ItemMutation,
} from "@canvas-physics/protocol";
import {
  ItemMutationSession,
  type ItemMutationEffect,
} from "../src/runtime/session/item-mutation-session.js";
import type {
  SessionClock,
  SessionInterval,
  SessionTimeout,
} from "../src/runtime/session/session-clock.js";
import {
  crateDefinition,
  rocketCanvas,
  rocketCanvasDefinitions,
} from "../src/definitions/rocket-canvas.js";

class FakeClock implements SessionClock {
  private time = 1_000;
  private nextId = 0;
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.time; }

  setTimeout(callback: () => void, delayMs: number): SessionTimeout {
    const id = ++this.nextId;
    this.scheduled.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(timeout: SessionTimeout): void {
    this.scheduled.delete(timeout as number);
  }

  setInterval(_callback: () => void, _everyMs: number): SessionInterval {
    throw new Error("transaction tests use timeout scheduling only");
  }

  clearInterval(_interval: SessionInterval): void {}

  advance(ms: number): void {
    this.time += ms;
    let runnable = true;
    while (runnable) {
      runnable = false;
      for (const [id, task] of [...this.scheduled].sort((a, b) => a[1].at - b[1].at)) {
        if (task.at > this.time) continue;
        this.scheduled.delete(id);
        task.callback();
        runnable = true;
        break;
      }
    }
  }
}

const transform = (x: number): Transform => ({ x, y: 20, rotation: 0, scale: 1 });

const item = (revision = 1): SnapshotItem => ({
  entityId: "crate-1",
  definitionId: crateDefinition.definitionId,
  definitionVersion: crateDefinition.version,
  ownerUserId: "alice",
  itemRevision: revision,
  transform: transform(12),
  resolvedConfig: {},
});

const build = () => {
  const clock = new FakeClock();
  const effects: ItemMutationEffect[] = [];
  const session = new ItemMutationSession({
    clientSessionId: "browser-session",
    definitions: rocketCanvasDefinitions,
    previewHz: 10,
    clock,
    context: () => ({
      clientId: "client-1",
      userId: "alice",
      sceneRevision: 4,
      isHost: true,
      canvas: rocketCanvas,
    }),
    emit: (effect) => effects.push(effect),
  });
  session.loadSnapshot({
    ...emptySnapshot(rocketCanvas.id, rocketCanvas.version),
    items: [item()],
  });
  const sentMutations = (): ItemMutation[] => effects
    .filter((effect): effect is Extract<ItemMutationEffect, { type: "sendMutation" }> =>
      effect.type === "sendMutation")
    .map(({ mutation }) => mutation);
  return { clock, effects, session, sentMutations };
};

describe("ItemMutationSession", () => {
  it("returns correlated receipts and serializes writes to one item", async () => {
    const { session, sentMutations } = build();

    const first = session.moveItem("crate-1", transform(20));
    const second = session.setItemConfig("crate-1", { color: "gold" });

    expect(first).toMatchObject({ clientSessionId: "browser-session", mutationId: 1 });
    expect(second.mutationId).toBe(2);
    expect(sentMutations()).toHaveLength(1);
    expect(sentMutations()[0]).toMatchObject({
      mutationId: 1,
      expectedItemRevision: 1,
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
    });

    session.acceptMutation({
      clientSessionId: "browser-session",
      mutationId: 1,
      editSessionId: "",
      accepted: true,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      sceneRevision: 5,
      itemRevision: 2,
      itemInstanceJson: new Uint8Array(),
      deletedEntityId: "",
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
      entityId: "crate-1",
    }, item(2));

    await expect(first.settled).resolves.toMatchObject({
      status: "accepted",
      mutationId: 1,
      itemRevision: 2,
    });
    expect(sentMutations()).toHaveLength(2);
    expect(sentMutations()[1]).toMatchObject({
      mutationId: 2,
      expectedItemRevision: 2,
      kind: ItemMutationKind.ITEM_MUTATION_CONFIG,
    });
  });

  it("sends mutations for different items concurrently", () => {
    const { session, sentMutations } = build();
    session.loadSnapshot({
      ...emptySnapshot(rocketCanvas.id, rocketCanvas.version),
      items: [
        item(),
        { ...item(), entityId: "crate-2", transform: transform(24) },
      ],
    });

    session.moveItem("crate-1", transform(20));
    session.moveItem("crate-2", transform(30));

    expect(sentMutations()).toHaveLength(2);
    expect(sentMutations().map(({ entityId }) => entityId)).toEqual(["crate-1", "crate-2"]);
  });

  it("settles a typed rejection without emitting a generic error", async () => {
    const { effects, session } = build();
    const receipt = session.deleteItem("crate-1");

    session.acceptMutation({
      clientSessionId: "browser-session",
      mutationId: receipt.mutationId,
      editSessionId: "",
      accepted: false,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_NOT_OWNER,
      message: "not_owner",
      sceneRevision: 4,
      itemRevision: 1,
      itemInstanceJson: new Uint8Array(),
      deletedEntityId: "",
      kind: ItemMutationKind.ITEM_MUTATION_DELETE,
      entityId: "crate-1",
    }, item());

    await expect(receipt.settled).resolves.toMatchObject({
      status: "rejected",
      code: "not_owner",
      authoritativeItem: expect.objectContaining({ entityId: "crate-1" }),
    });
    expect(effects.some((effect) => effect.type === "rejected")).toBe(false);
  });

  it("opens one edit handle and coalesces a sequenced preview stream", () => {
    const { clock, effects, session } = build();
    const edit = session.beginItemEdit("crate-1");
    edit.preview(transform(20));

    expect(edit.state).toBe("opening");
    expect(effects.filter((effect) => effect.type === "sendPreview")).toHaveLength(0);

    session.acceptEditSession({
      clientSessionId: "browser-session",
      editSessionId: edit.editSessionId,
      entityId: "crate-1",
      status: ItemEditSessionStatus.ITEM_EDIT_SESSION_ACTIVE,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      itemRevision: 1,
      leaseExpiresAtUnixMs: 2_000,
      itemInstanceJson: new Uint8Array(),
    }, item());
    expect(edit.state).toBe("active");
    expect(effects.filter((effect) => effect.type === "sendPreview")).toHaveLength(1);

    edit.preview(transform(21));
    edit.preview(transform(22));
    clock.advance(100);
    const previews = effects
      .filter((effect): effect is Extract<ItemMutationEffect, { type: "sendPreview" }> =>
        effect.type === "sendPreview")
      .map((effect) => effect.preview);
    expect(previews).toHaveLength(2);
    expect(previews[1]).toMatchObject({ previewSequence: 2, position: { x: 22 } });
  });

  it("holds an edit at display cadence until its accepted revision is canonical", async () => {
    const { session } = build();
    const canonical = {
      id: "crate-1",
      kind: "item" as const,
      definitionId: crateDefinition.definitionId,
      x: 12,
      y: 20,
      rotation: 0,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
    };
    const edit = session.beginItemEdit("crate-1");
    session.acceptEditSession({
      clientSessionId: "browser-session",
      editSessionId: edit.editSessionId,
      entityId: "crate-1",
      status: ItemEditSessionStatus.ITEM_EDIT_SESSION_ACTIVE,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      itemRevision: 1,
      leaseExpiresAtUnixMs: 2_000,
      itemInstanceJson: new Uint8Array(),
    }, item());

    edit.preview(transform(30));
    expect(session.present([canonical])[0]).toMatchObject({ x: 30 });
    const receipt = edit.mutate({
      kind: "transform",
      entityId: "crate-1",
      transform: transform(30),
    });
    session.acceptMutation({
      clientSessionId: "browser-session",
      mutationId: receipt.mutationId,
      editSessionId: edit.editSessionId,
      accepted: true,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      sceneRevision: 5,
      itemRevision: 2,
      itemInstanceJson: new Uint8Array(),
      deletedEntityId: "",
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
      entityId: "crate-1",
    }, { ...item(2), transform: transform(30) });
    await receipt.settled;

    session.observeCanonical(4, [{ ...canonical, x: 30 }]);
    expect(session.present([canonical])[0]).toMatchObject({ x: 30 });
    session.observeCanonical(5, [{ ...canonical, x: 30 }]);
    expect(session.present([canonical])[0]).toMatchObject({ x: 12 });
  });

  it("cancels transient edits and resends durable mutations after reconnect", async () => {
    const { effects, session } = build();
    const edit = session.beginItemEdit("crate-1");
    const receipt = session.moveItem("crate-1", transform(30));
    const firstSend = effects.find(
      (effect): effect is Extract<ItemMutationEffect, { type: "sendMutation" }> =>
        effect.type === "sendMutation",
    )!;

    session.resetConnection();
    expect(edit.state).toBe("ended");
    await expect(edit.ended).resolves.toMatchObject({ status: "superseded" });

    session.connectionReady();
    const sends = effects.filter(
      (effect): effect is Extract<ItemMutationEffect, { type: "sendMutation" }> =>
        effect.type === "sendMutation",
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]!.mutation).toEqual(firstSend.mutation);

    session.acceptMutation({
      clientSessionId: "browser-session",
      mutationId: receipt.mutationId,
      editSessionId: "",
      accepted: true,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      sceneRevision: 5,
      itemRevision: 2,
      itemInstanceJson: new Uint8Array(),
      deletedEntityId: "",
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
      entityId: "crate-1",
    }, item(2));
    await expect(receipt.settled).resolves.toMatchObject({ status: "accepted" });
  });

  it("holds mutations created during reconnect until the new join is ready", () => {
    const { session, sentMutations } = build();

    session.resetConnection();
    const receipt = session.moveItem("crate-1", transform(30));

    expect(receipt).toMatchObject({ mutationId: 1 });
    expect(sentMutations()).toHaveLength(0);

    session.connectionReady();
    expect(sentMutations()).toHaveLength(1);
    expect(sentMutations()[0]).toMatchObject({
      mutationId: receipt.mutationId,
      kind: ItemMutationKind.ITEM_MUTATION_TRANSFORM,
    });
  });

  it("owns canonical item metadata and translates accepted host mutations", () => {
    const { effects, session } = build();
    expect(session.decorate({
      id: "crate-1",
      kind: "item",
      definitionId: "",
      x: 12,
      y: 20,
      rotation: 0,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
    })).toMatchObject({
      definitionId: crateDefinition.definitionId,
      ownerUserId: "alice",
    });

    session.acceptMutation({
      clientSessionId: "another-browser",
      mutationId: 9,
      editSessionId: "",
      accepted: true,
      rejectCode: ItemMutationRejectCode.ITEM_MUTATION_REJECT_UNSPECIFIED,
      message: "",
      sceneRevision: 5,
      itemRevision: 2,
      itemInstanceJson: new Uint8Array(),
      deletedEntityId: "crate-1",
      kind: ItemMutationKind.ITEM_MUTATION_DELETE,
      entityId: "crate-1",
    });
    expect(effects).toContainEqual({
      type: "simulate",
      request: { type: "removeItem", entityId: "crate-1" },
    });
    expect(session.itemCount).toBe(0);
  });
});
