import { describe, expect, it, vi } from "vitest";
import { emptySnapshot, type CanvasDefinition } from "@canvas-physics/core";
import {
  ConnectionSession,
  type ConnectionEffect,
} from "../src/runtime/session/connection-session.js";

const canvas = (id: string): CanvasDefinition => ({
  id,
  version: 1,
  width: 100,
  height: 80,
  background: { kind: "color", value: "#000" },
  boundarySegments: [],
  zones: [],
  spawnPoints: [{ id: "start", position: { x: 10, y: 10 } }],
  itemInstances: [],
});

describe("ConnectionSession", () => {
  it("installs only the newest JOIN generation when reconnect wins initialization", async () => {
    let release!: () => void;
    const initialized = new Promise<void>((resolve) => { release = resolve; });
    const installed: string[] = [];
    const effects: ConnectionEffect[] = [];
    const connection = new ConnectionSession({
      initializeConsumer: () => initialized,
      installJoin: ({ canvas: definition }) => installed.push(definition.id),
      emit: (effect) => effects.push(effect),
    });

    connection.transportStatus("open");
    connection.joined(canvas("first"), emptySnapshot("first", 1), false);
    connection.transportStatus("reconnecting", "socket replaced");
    connection.transportStatus("open");
    connection.joined(canvas("first"), emptySnapshot("first", 1), false);

    release();
    await vi.waitFor(() => expect(connection.lifecycleState).toBe("active"));
    expect(installed).toEqual(["first"]);
    expect(connection.generation).toBe(3);
    expect(effects.filter(({ type }) => type === "connectionReset")).toHaveLength(3);
  });

  it("makes a pending initialization completion inert after terminal stop", async () => {
    let release!: () => void;
    const initialized = new Promise<void>((resolve) => { release = resolve; });
    const installJoin = vi.fn();
    const connection = new ConnectionSession({
      initializeConsumer: () => initialized,
      installJoin,
      emit: vi.fn(),
    });
    connection.transportStatus("open");
    connection.joined(canvas("room"), emptySnapshot("room", 1), false);

    expect(connection.beginStop()).toBe(true);
    connection.finishStop();
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.lifecycleState).toBe("stopped");
    expect(installJoin).not.toHaveBeenCalled();
    expect(connection.generation).toBe(2);
  });

  it("settles readiness and failure once with typed terminal state", async () => {
    const effects: ConnectionEffect[] = [];
    const connection = new ConnectionSession({
      installJoin: vi.fn(),
      emit: (effect) => effects.push(effect),
    });
    const ready = connection.whenReady();
    connection.transportStatus("failed", "retries exhausted");

    await expect(ready).rejects.toMatchObject({
      code: "transport_reconnect_exhausted",
      source: "transport",
    });
    expect(connection.lifecycleState).toBe("failed");
    expect(connection.fail(new Error("late") as never)).toBe(false);
    expect(effects.filter(({ type }) => type === "failed")).toHaveLength(1);
  });

  it("coalesces starts and reports cancellation after stop", async () => {
    let release!: () => void;
    const connect = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const connection = new ConnectionSession({ installJoin: vi.fn(), emit: vi.fn() });

    const first = connection.start(connect);
    expect(connection.start(connect)).toBe(first);
    expect(connect).toHaveBeenCalledOnce();
    connection.beginStop();
    connection.finishStop();
    release();

    await expect(first).rejects.toMatchObject({ code: "start_cancelled" });
  });

  it("owns and cancels connection-scoped schedules at terminal transition", () => {
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      const connection = new ConnectionSession({ installJoin: vi.fn(), emit: vi.fn() });
      connection.schedule(callback, 10);
      vi.advanceTimersByTime(25);
      expect(callback).toHaveBeenCalledTimes(2);

      connection.beginStop();
      connection.finishStop();
      vi.advanceTimersByTime(25);
      expect(callback).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
