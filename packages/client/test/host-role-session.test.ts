import { describe, expect, it, vi } from "vitest";
import type { CanvasDefinition, CanvasSnapshot } from "@canvas-physics/core";
import type { SimulationResponse } from "../src/simulation/messages.js";
import {
  HostRoleSession,
  type HostRoleEffect,
} from "../src/runtime/session/host-role-session.js";
import type {
  SessionClock,
  SessionInterval,
  SessionTimeout,
} from "../src/runtime/session/session-clock.js";

class FakeClock implements SessionClock {
  private id = 0;
  private nowMs = 0;
  private readonly timeouts = new Map<number, { at: number; callback: () => void }>();
  private readonly intervals = new Map<
    number,
    { every: number; next: number; callback: () => void }
  >();

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): SessionTimeout {
    const id = ++this.id;
    this.timeouts.set(id, { at: this.nowMs + delayMs, callback });
    return id as unknown as SessionTimeout;
  }

  clearTimeout(timeout: SessionTimeout): void {
    this.timeouts.delete(timeout as unknown as number);
  }

  setInterval(callback: () => void, everyMs: number): SessionInterval {
    const id = ++this.id;
    this.intervals.set(id, {
      every: everyMs,
      next: this.nowMs + everyMs,
      callback,
    });
    return id as unknown as SessionInterval;
  }

  clearInterval(interval: SessionInterval): void {
    this.intervals.delete(interval as unknown as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const timeout = [...this.timeouts.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      const interval = [...this.intervals.entries()]
        .filter(([, entry]) => entry.next <= target)
        .sort((a, b) => a[1].next - b[1].next)[0];
      const timeoutAt = timeout?.[1].at ?? Infinity;
      const intervalAt = interval?.[1].next ?? Infinity;
      if (timeoutAt === Infinity && intervalAt === Infinity) break;
      if (timeoutAt <= intervalAt) {
        this.nowMs = timeoutAt;
        this.timeouts.delete(timeout![0]);
        timeout![1].callback();
      } else {
        this.nowMs = intervalAt;
        const current = this.intervals.get(interval![0]);
        if (!current) continue;
        current.next += current.every;
        current.callback();
      }
    }
    this.nowMs = target;
  }

  get intervalCount(): number {
    return this.intervals.size;
  }
}

const canvas: CanvasDefinition = {
  id: "room",
  version: 1,
  width: 100,
  height: 80,
  background: { kind: "color", value: "#000" },
  boundarySegments: [],
  zones: [],
  spawnPoints: [{ id: "start", position: { x: 10, y: 10 } }],
  itemInstances: [],
};

const snapshot = (epoch: number): CanvasSnapshot => ({
  schemaVersion: 1,
  canvasId: "room",
  canvasVersion: 1,
  sceneRevision: 0,
  hostEpoch: epoch,
  checkpointRevision: 0,
  tick: 0,
  capturedAt: "2026-08-25T00:00:00.000Z",
  normalized: true,
  items: [],
  avatars: [],
});

const ready = (generation: number): SimulationResponse => ({
  type: "ready",
  generation,
});

describe("HostRoleSession", () => {
  it("owns one host schedule across rapid grant-change-grant transitions", () => {
    const clock = new FakeClock();
    const effects: HostRoleEffect[] = [];
    const role = new HostRoleSession({ clock, emit: (effect) => effects.push(effect) });

    role.initialize({
      epoch: 1,
      isHost: true,
      canvas,
      definitions: [],
      tickRate: 60,
      snapshot: snapshot(1),
      wakeFromSleep: false,
      localAvatar: {
        entityId: "avatar:alice",
        clientId: "c1",
        userId: "alice",
        position: { x: 10, y: 10 },
      },
    });
    expect(role.isHost).toBe(true);
    expect(role.generation).toBe(1);
    expect(clock.intervalCount).toBe(3);

    expect(role.change({ epoch: 2, localIsHost: false, reason: "lease_expired" })).toBe(true);
    expect(clock.intervalCount).toBe(0);
    expect(role.grant({ epoch: 3, snapshot: snapshot(3), reason: "host_disconnected" })).toBe(true);
    expect(clock.intervalCount).toBe(3);
    expect(role.change({ epoch: 2, localIsHost: false, reason: "late" })).toBe(false);
    expect(role.isHost).toBe(true);
    expect(clock.intervalCount).toBe(3);
    expect(role.diagnostics).toMatchObject({
      hostEpoch: 3,
      hostMigrations: 2,
      lastMigrationReason: "host_disconnected",
      invariantViolations: 1,
    });

    effects.length = 0;
    clock.advance(1_000);
    expect(effects.filter(({ type }) => type === "publishFrame")).toHaveLength(17);
    expect(effects.filter(({ type }) => type === "requestCheckpoint")).toHaveLength(1);
  });

  it("rejects a hidden promotion and yields without starting host schedules", () => {
    const clock = new FakeClock();
    const effects: HostRoleEffect[] = [];
    const role = new HostRoleSession({ clock, emit: (effect) => effects.push(effect) });
    role.initialize({
      epoch: 1,
      isHost: false,
      canvas,
      definitions: [],
      tickRate: 60,
      snapshot: snapshot(1),
      wakeFromSleep: false,
      localAvatar: {
        entityId: "avatar:alice",
        clientId: "c1",
        userId: "alice",
        position: { x: 10, y: 10 },
      },
    });
    role.setPageVisible(false);

    expect(role.grant({ epoch: 2, snapshot: snapshot(2), reason: "host_disconnected" }))
      .toBe(false);
    expect(role.isHost).toBe(false);
    expect(clock.intervalCount).toBe(0);
    expect(effects.at(-1)).toEqual({ type: "yieldHost", reason: "page_hidden" });
  });

  it("accepts worker responses only from the active simulation generation", () => {
    const role = new HostRoleSession({ emit: vi.fn() });
    role.initialize({
      epoch: 1,
      isHost: true,
      canvas,
      definitions: [],
      tickRate: 60,
      snapshot: snapshot(1),
      wakeFromSleep: false,
      localAvatar: {
        entityId: "avatar:alice",
        clientId: "c1",
        userId: "alice",
        position: { x: 10, y: 10 },
      },
    });
    const oldGeneration = role.generation;
    role.change({ epoch: 2, localIsHost: false, reason: "lease_expired" });

    expect(role.acceptSimulation(ready(oldGeneration))).toBe(false);
    expect(role.acceptSimulation(ready(role.generation))).toBe(true);
    expect(role.simulationReady).toBe(true);
    expect(role.diagnostics.staleSimulationResponses).toBe(1);
  });

  it("settles graceful final checkpoint only for the active generation or timeout", async () => {
    const clock = new FakeClock();
    const effects: HostRoleEffect[] = [];
    const role = new HostRoleSession({ clock, emit: (effect) => effects.push(effect) });
    role.initialize({
      epoch: 4,
      isHost: true,
      canvas,
      definitions: [],
      tickRate: 60,
      snapshot: snapshot(4),
      wakeFromSleep: false,
      localAvatar: {
        entityId: "avatar:alice",
        clientId: "c1",
        userId: "alice",
        position: { x: 10, y: 10 },
      },
    });
    role.acceptSimulation(ready(role.generation));
    const generation = role.generation;
    const finished = role.requestFinalCheckpoint(7, 250);
    expect(clock.intervalCount).toBe(0);
    expect(effects.at(-1)).toMatchObject({
      type: "requestCheckpoint",
      final: true,
      generation,
      hostEpoch: 4,
      sceneRevision: 7,
    });

    expect(role.acceptSimulation({
      type: "snapshot",
      generation: generation - 1,
      snapshot: snapshot(3),
      final: true,
    })).toBe(false);
    let settled = false;
    void finished.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    role.acceptSimulation({
      type: "snapshot",
      generation,
      snapshot: snapshot(4),
      final: true,
    });
    await finished;
    expect(settled).toBe(true);

    role.grant({ epoch: 5, snapshot: snapshot(5), reason: "host_disconnected" });
    role.acceptSimulation(ready(role.generation));
    const timedOut = role.requestFinalCheckpoint(8, 250);
    clock.advance(250);
    await expect(timedOut).resolves.toBeUndefined();
  });
});
