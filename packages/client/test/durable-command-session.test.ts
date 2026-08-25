import { describe, expect, it } from "vitest";
import { emptySnapshot, type SnapshotItem, type Transform } from "@canvas-physics/core";
import { DurableCommandKind, type DurableCommand } from "@canvas-physics/protocol";
import {
  DurableCommandSession,
  type DurableCommandEffect,
} from "../src/runtime/session/durable-command-session.js";
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

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): SessionTimeout {
    const id = ++this.nextId;
    this.scheduled.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(timeout: SessionTimeout): void {
    this.scheduled.delete(timeout as number);
  }

  setInterval(_callback: () => void, _everyMs: number): SessionInterval {
    throw new Error("durable command tests do not schedule intervals");
  }

  clearInterval(_interval: SessionInterval): void {}

  advance(ms: number): void {
    this.time += ms;
    for (const [id, task] of [...this.scheduled].sort((a, b) => a[1].at - b[1].at)) {
      if (task.at > this.time) continue;
      this.scheduled.delete(id);
      task.callback();
    }
  }
}

const transform = (x: number): Transform => ({ x, y: 20, rotation: 0, scale: 1 });

const build = () => {
  const clock = new FakeClock();
  const effects: DurableCommandEffect[] = [];
  const session = new DurableCommandSession({
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
  const sent = (): DurableCommand[] => effects
    .filter((effect): effect is Extract<DurableCommandEffect, { type: "send" }> =>
      effect.type === "send")
    .map(({ command }) => command);
  return { clock, effects, session, sent };
};

describe("DurableCommandSession", () => {
  it("coalesces previews with virtual time and sends a commit immediately", () => {
    const { clock, session, sent } = build();

    session.moveItem("item-1", transform(1), true);
    session.moveItem("item-1", transform(2), true);
    session.moveItem("item-1", transform(3), true);
    expect(sent()).toHaveLength(1);

    clock.advance(100);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({ preview: true, position: { x: 3 } });

    session.moveItem("item-1", transform(4), true);
    session.moveItem("item-1", transform(5));
    expect(sent()).toHaveLength(3);
    expect(sent().at(-1)).toMatchObject({ preview: false, position: { x: 5 } });
    clock.advance(100);
    expect(sent()).toHaveLength(3);
  });

  it("drops an unconfirmed preview when the connection generation changes", () => {
    const { clock, session, sent } = build();
    session.moveItem("item-1", transform(1), true);
    session.moveItem("item-1", transform(2), true);

    session.resetConnection();
    clock.advance(100);

    expect(sent()).toHaveLength(1);
  });

  it("owns canonical item metadata and translates accepted host commands", () => {
    const { effects, session } = build();
    const item: SnapshotItem = {
      entityId: "crate-1",
      definitionId: crateDefinition.definitionId,
      definitionVersion: crateDefinition.version,
      ownerUserId: "alice",
      transform: transform(12),
      resolvedConfig: {},
    };
    session.loadSnapshot({
      ...emptySnapshot(rocketCanvas.id, rocketCanvas.version),
      items: [item],
    });
    expect(session.itemCount).toBe(1);
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

    session.accept({
      commandId: "client-1-1",
      kind: DurableCommandKind.DURABLE_DELETE_ITEM,
      entityId: "crate-1",
      definitionId: "",
      definitionVersion: 0,
      rotation: 0,
      scale: 0,
      z: 0,
      configJson: new Uint8Array(),
      preview: false,
      isolated: false,
      collisionsEnabled: false,
    });
    expect(effects).toContainEqual({
      type: "simulate",
      request: { type: "removeItem", entityId: "crate-1" },
    });
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
    }).ownerUserId).toBeUndefined();
  });

  it("emits a typed rejection effect without disturbing unrelated metadata", () => {
    const { effects, session } = build();
    session.loadSnapshot({
      ...emptySnapshot(rocketCanvas.id, rocketCanvas.version),
      items: [{
        entityId: "crate-1",
        definitionId: crateDefinition.definitionId,
        definitionVersion: crateDefinition.version,
        ownerUserId: "alice",
        transform: transform(12),
        resolvedConfig: {},
      }],
    });

    session.reject("not_owner");

    expect(effects.at(-1)).toEqual({ type: "rejected", reason: "not_owner" });
    expect(session.itemCount).toBe(1);
  });
});
