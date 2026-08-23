import type { EntityId } from "../registry/components.js";
import type { BehaviorTimerSnapshot } from "../model/snapshot.js";
import type { TimerEvent } from "./events.js";

interface TimerRecord {
  id: string;
  entityId: EntityId;
  key: string;
  startTick: number;
  dueTick: number;
}

/**
 * Timers count simulation ticks, not wall-clock time (spec 2.2, 8.4). This keeps
 * countdowns identical on a 60 Hz host and a 30 Hz low-power host profile.
 */
export class TimerService {
  private readonly timers = new Map<string, TimerRecord>();
  private readonly byEntity = new Map<EntityId, Set<string>>();
  private readonly pausedAt = new Map<EntityId, number>();
  private nextId = 1;

  constructor(private readonly tickRate: number) {}

  ticksFor(seconds: number): number {
    return Math.max(1, Math.round(seconds * this.tickRate));
  }

  schedule(
    entityId: EntityId,
    key: string,
    seconds: number,
    currentTick: number,
    replace = true,
  ): string {
    if (replace) this.cancel(entityId, key);
    const id = `t${this.nextId++}`;
    const record: TimerRecord = {
      id,
      entityId,
      key,
      startTick: currentTick,
      dueTick: currentTick + this.ticksFor(seconds),
    };
    this.timers.set(id, record);
    let keys = this.byEntity.get(entityId);
    if (!keys) {
      keys = new Set();
      this.byEntity.set(entityId, keys);
    }
    keys.add(id);
    return id;
  }

  cancel(entityId: EntityId, key: string): void {
    const ids = this.byEntity.get(entityId);
    if (!ids) return;
    for (const id of [...ids]) {
      if (this.timers.get(id)?.key === key) {
        this.timers.delete(id);
        ids.delete(id);
      }
    }
  }

  cancelAll(entityId: EntityId): void {
    for (const id of this.byEntity.get(entityId) ?? []) this.timers.delete(id);
    this.byEntity.delete(entityId);
    this.pausedAt.delete(entityId);
  }

  /** Pauses an entity's simulation-clock timers without losing their remainder. */
  setPaused(entityId: EntityId, paused: boolean, currentTick: number): void {
    const since = this.pausedAt.get(entityId);
    if (paused) {
      if (since === undefined) this.pausedAt.set(entityId, currentTick);
      return;
    }
    if (since === undefined) return;
    const heldTicks = Math.max(0, currentTick - since);
    for (const id of this.byEntity.get(entityId) ?? []) {
      const timer = this.timers.get(id);
      if (!timer) continue;
      timer.startTick += heldTicks;
      timer.dueTick += heldTicks;
    }
    this.pausedAt.delete(entityId);
  }

  /** Captures active timers relative to the checkpoint tick. */
  snapshot(entityId: EntityId, currentTick: number): BehaviorTimerSnapshot[] {
    const effectiveTick = this.pausedAt.get(entityId) ?? currentTick;
    const timers: BehaviorTimerSnapshot[] = [];
    for (const id of this.byEntity.get(entityId) ?? []) {
      const record = this.timers.get(id);
      if (!record) continue;
      timers.push({
        key: record.key,
        elapsedTicks: Math.max(0, effectiveTick - record.startTick),
        remainingTicks: Math.max(1, record.dueTick - effectiveTick),
      });
    }
    return timers.sort(
      (a, b) =>
        a.remainingTicks - b.remainingTicks ||
        a.key.localeCompare(b.key) ||
        a.elapsedTicks - b.elapsedTicks,
    );
  }

  /** Recreates timers captured by an active host checkpoint. */
  restore(
    entityId: EntityId,
    timers: readonly BehaviorTimerSnapshot[],
    currentTick: number,
  ): void {
    for (const timer of timers) {
      const id = `t${this.nextId++}`;
      const record: TimerRecord = {
        id,
        entityId,
        key: timer.key,
        startTick: currentTick - Math.max(0, Math.floor(timer.elapsedTicks)),
        dueTick: currentTick + Math.max(1, Math.floor(timer.remainingTicks)),
      };
      this.timers.set(id, record);
      let ids = this.byEntity.get(entityId);
      if (!ids) {
        ids = new Set();
        this.byEntity.set(entityId, ids);
      }
      ids.add(id);
    }
  }

  /** Remaining ticks for a timer, or undefined when none is pending. */
  remaining(entityId: EntityId, key: string, currentTick: number): number | undefined {
    for (const id of this.byEntity.get(entityId) ?? []) {
      const record = this.timers.get(id);
      if (record?.key === key) return record.dueTick - currentTick;
    }
    return undefined;
  }

  /** Timers due on or before `tick`, in schedule order. */
  collectDue(tick: number): TimerEvent[] {
    const due: TimerRecord[] = [];
    for (const record of this.timers.values()) {
      if (!this.pausedAt.has(record.entityId) && record.dueTick <= tick) due.push(record);
    }
    due.sort((a, b) => a.dueTick - b.dueTick || a.id.localeCompare(b.id));
    for (const record of due) {
      this.timers.delete(record.id);
      this.byEntity.get(record.entityId)?.delete(record.id);
    }
    return due.map((record) => ({
      type: "timer",
      tick,
      self: record.entityId,
      timerId: record.id,
      key: record.key,
      elapsedTicks: tick - record.startTick,
    }));
  }

  /** Spec 13.3. Room sleep stops every timer. */
  clear(): void {
    this.timers.clear();
    this.byEntity.clear();
    this.pausedAt.clear();
  }

  get pending(): number {
    return this.timers.size;
  }
}
