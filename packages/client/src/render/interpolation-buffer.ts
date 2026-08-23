import type { RenderEntity } from "../simulation/messages.js";

interface Sample {
  tick: number;
  receivedAtMs: number;
  entities: Map<string, RenderEntity>;
}

export interface InterpolatedEntity extends RenderEntity {
  /** True when the value came from extrapolation, not from two samples. */
  extrapolated: boolean;
}

export interface InterpolationOptions {
  /** Render delay in milliseconds. Spec 10.4 suggests about 100 ms. */
  delayMs?: number;
  /** Stop extrapolating after this long rather than letting an item drift. */
  maxExtrapolationMs?: number;
  bufferSize?: number;
}

/**
 * Spec 10.4. Keeps a short buffer of host states and renders remote entities
 * slightly behind the newest packet.
 */
export class InterpolationBuffer {
  private samples: Sample[] = [];
  private readonly delayMs: number;
  private readonly maxExtrapolationMs: number;
  private readonly bufferSize: number;
  extrapolationCount = 0;

  constructor(options: InterpolationOptions = {}) {
    this.delayMs = options.delayMs ?? 100;
    this.maxExtrapolationMs = options.maxExtrapolationMs ?? 250;
    this.bufferSize = options.bufferSize ?? 20;
  }

  get depth(): number {
    return this.samples.length;
  }

  /** Complete newest canonical sample, without interpolation or prediction. */
  latest(): RenderEntity[] {
    const newest = this.samples[this.samples.length - 1];
    return newest ? [...newest.entities.values()] : [];
  }

  /** Clears history. Call it when the host epoch changes (spec 11.2). */
  reset(): void {
    this.samples = [];
    this.extrapolationCount = 0;
  }

  push(tick: number, entities: RenderEntity[], nowMs = performance.now()): void {
    const map = new Map<string, RenderEntity>();
    for (const entity of entities) map.set(entity.id, entity);
    this.samples.push({ tick, receivedAtMs: nowMs, entities: map });
    this.samples.sort((a, b) => a.tick - b.tick);
    while (this.samples.length > this.bufferSize) this.samples.shift();
  }

  /** Merges a delta into the newest sample so partial updates accumulate. */
  pushDelta(
    tick: number,
    entities: RenderEntity[],
    removed: string[] = [],
    nowMs = performance.now(),
  ): void {
    const newest = this.samples[this.samples.length - 1];
    const merged = new Map(newest ? newest.entities : undefined);
    for (const entity of entities) {
      // Spec 19.3. A delta leaves out the definition id, so the value from the
      // last keyframe is carried forward.
      const before = merged.get(entity.id);
      merged.set(entity.id, {
        ...before,
        ...entity,
        definitionId: entity.definitionId || before?.definitionId || "",
        behaviorState: entity.behaviorState ?? before?.behaviorState,
        userId: entity.userId ?? before?.userId,
        ownerUserId: entity.ownerUserId ?? before?.ownerUserId,
      });
    }
    for (const id of removed) merged.delete(id);
    this.samples.push({ tick, receivedAtMs: nowMs, entities: merged });
    while (this.samples.length > this.bufferSize) this.samples.shift();
  }

  /** The entities to draw at `nowMs`, interpolated or briefly extrapolated. */
  sample(nowMs = performance.now()): InterpolatedEntity[] {
    if (this.samples.length === 0) return [];
    const targetMs = nowMs - this.delayMs;

    let older: Sample | undefined;
    let newer: Sample | undefined;
    for (const sample of this.samples) {
      if (sample.receivedAtMs <= targetMs) older = sample;
      else if (!newer) newer = sample;
    }

    if (older && newer && newer.receivedAtMs > older.receivedAtMs) {
      const span = newer.receivedAtMs - older.receivedAtMs;
      const t = Math.max(0, Math.min(1, (targetMs - older.receivedAtMs) / span));
      return this.blend(older, newer, t);
    }

    const newest = this.samples[this.samples.length - 1]!;
    const aheadMs = Math.min(targetMs - newest.receivedAtMs, this.maxExtrapolationMs);
    if (aheadMs <= 0) {
      return [...newest.entities.values()].map((entity) => ({
        ...entity,
        extrapolated: false,
      }));
    }
    this.extrapolationCount++;
    const seconds = aheadMs / 1000;
    return [...newest.entities.values()].map((entity) => ({
      ...entity,
      x: entity.x + entity.vx * seconds,
      y: entity.y + entity.vy * seconds,
      rotation: entity.rotation + entity.angularVelocity * seconds,
      extrapolated: true,
    }));
  }

  private blend(older: Sample, newer: Sample, t: number): InterpolatedEntity[] {
    const out: InterpolatedEntity[] = [];
    for (const [id, target] of newer.entities) {
      const from = older.entities.get(id);
      if (!from) {
        out.push({ ...target, extrapolated: false });
        continue;
      }
      // Addendum A2. The body jumped, for example across a wrapped edge. A
      // blend between the two ends would slide the sprite back across the
      // whole canvas, so the newer state is drawn as it is.
      if ((from.teleportEpoch ?? 0) !== (target.teleportEpoch ?? 0)) {
        out.push({ ...target, extrapolated: false });
        continue;
      }
      out.push({
        ...target,
        x: from.x + (target.x - from.x) * t,
        y: from.y + (target.y - from.y) * t,
        rotation: from.rotation + shortestAngle(from.rotation, target.rotation) * t,
        scale:
          (from.scale ?? 1) + ((target.scale ?? 1) - (from.scale ?? 1)) * t,
        z:
          from.z !== undefined && target.z !== undefined
            ? from.z + (target.z - from.z) * t
            : target.z,
        extrapolated: false,
      });
    }
    return out;
  }
}

const shortestAngle = (from: number, to: number): number => {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
};
