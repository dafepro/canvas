import type { Vec2 } from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";

export const MAX_OVERLAY_OBSERVATION_HZ = 60;
export const MAX_OVERLAY_ENTITIES = 256;
export const DEFAULT_OVERLAY_OBSERVATION_HZ = 10;
export const DEFAULT_OVERLAY_ENTITIES = 128;
const FRAME_CADENCE_TOLERANCE_MS = 0.75;

export interface OverlayViewportProjection {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface OverlayProjectionSource {
  readonly sampledAtMs: number;
  readonly tick: number;
  readonly canvasSize: Readonly<{ width: number; height: number }>;
  readonly viewport: Readonly<OverlayViewportProjection>;
  readonly entities: readonly Readonly<RenderEntity>[];
}

export interface OverlayEntityProjection {
  readonly entityId: string;
  readonly kind: RenderEntity["kind"];
  readonly definitionId: string;
  readonly world: Readonly<{ x: number; y: number; z: number }>;
  readonly screen: Readonly<Vec2>;
  readonly rotation: number;
  readonly visible: boolean;
  readonly inCanvas: boolean;
  readonly inViewport: boolean;
  readonly disabled: boolean;
  readonly quarantined: boolean;
}

export interface OverlayPointProjection {
  readonly world: Readonly<{ x: number; y: number; z: number }>;
  readonly screen: Readonly<Vec2>;
  readonly inCanvas: boolean;
  readonly inViewport: boolean;
}

export interface OverlayProjectionSnapshot {
  readonly sampledAtMs: number;
  readonly tick: number;
  readonly canvasSize: Readonly<{ width: number; height: number }>;
  readonly viewport: Readonly<OverlayViewportProjection>;
  readonly entities: readonly Readonly<OverlayEntityProjection>[];
  /** Number selected before maxEntities was applied. */
  readonly matchedEntities: number;
  readonly truncated: boolean;
}

export interface OverlayProjectionOptions {
  /** Defaults to 10 and may not exceed 60. */
  readonly maxHz?: number;
  /** Defaults to 128 and may not exceed 256. */
  readonly maxEntities?: number;
  /** At most 256 IDs. Empty means no ID filter. */
  readonly entityIds?: readonly string[];
  readonly kinds?: readonly RenderEntity["kind"][];
  readonly definitionIds?: readonly string[];
}

/** Converts renderer backing coordinates into DOM/CSS coordinates. */
export const cssOverlayViewport = (
  viewport: Readonly<OverlayViewportProjection>,
  cssSize: Readonly<{ width: number; height: number }>,
): Readonly<OverlayViewportProjection> => {
  const xRatio = viewport.width > 0 ? cssSize.width / viewport.width : 1;
  const yRatio = viewport.height > 0 ? cssSize.height / viewport.height : xRatio;
  return Object.freeze({
    width: cssSize.width,
    height: cssSize.height,
    scale: viewport.scale * xRatio,
    offsetX: viewport.offsetX * xRatio,
    offsetY: viewport.offsetY * yRatio,
  });
};

/** Converts a DOM pointer position into renderer backing coordinates. */
export const cssPointToRenderer = (
  point: Readonly<Vec2>,
  rendererSize: Readonly<{ width: number; height: number }>,
  cssSize: Readonly<{ width: number; height: number }>,
): Readonly<Vec2> => Object.freeze({
  x: point.x * (cssSize.width > 0 ? rendererSize.width / cssSize.width : 1),
  y: point.y * (cssSize.height > 0 ? rendererSize.height / cssSize.height : 1),
});

export type OverlayProjectionObserver = (
  snapshot: Readonly<OverlayProjectionSnapshot>,
) => void;

interface Subscription {
  readonly observer: OverlayProjectionObserver;
  readonly intervalMs: number;
  readonly maxEntities: number;
  readonly entityIds?: ReadonlySet<string>;
  readonly kinds?: ReadonlySet<RenderEntity["kind"]>;
  readonly definitionIds?: ReadonlySet<string>;
  lastPublishedAtMs: number;
}

/**
 * Converts renderer samples into immutable plain data for DOM/UI overlays.
 * It intentionally exposes no Pixi display objects, textures, or mutable camera.
 */
export class OverlayProjectionStore {
  private readonly subscriptions = new Set<Subscription>();

  get hasObservers(): boolean {
    return this.subscriptions.size > 0;
  }

  subscribe(
    observer: OverlayProjectionObserver,
    options: OverlayProjectionOptions = {},
  ): () => void {
    const maxHz = options.maxHz ?? DEFAULT_OVERLAY_OBSERVATION_HZ;
    const maxEntities = options.maxEntities ?? DEFAULT_OVERLAY_ENTITIES;
    assertFiniteRange("maxHz", maxHz, 0, MAX_OVERLAY_OBSERVATION_HZ);
    assertIntegerRange("maxEntities", maxEntities, 1, MAX_OVERLAY_ENTITIES);
    assertFilterBound("entityIds", options.entityIds);
    assertFilterBound("definitionIds", options.definitionIds);

    const subscription: Subscription = {
      observer,
      intervalMs: 1_000 / maxHz,
      maxEntities,
      entityIds: options.entityIds?.length ? new Set(options.entityIds) : undefined,
      kinds: options.kinds?.length ? new Set(options.kinds) : undefined,
      definitionIds: options.definitionIds?.length
        ? new Set(options.definitionIds)
        : undefined,
      lastPublishedAtMs: Number.NEGATIVE_INFINITY,
    };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }

  publish(source: OverlayProjectionSource): void {
    for (const subscription of this.subscriptions) {
      if (source.sampledAtMs - subscription.lastPublishedAtMs +
          FRAME_CADENCE_TOLERANCE_MS <
          subscription.intervalMs) continue;
      subscription.lastPublishedAtMs = source.sampledAtMs;
      const snapshot = projectSnapshot(source, subscription);
      try {
        subscription.observer(snapshot);
      } catch {
        // One application overlay must not interrupt rendering or other observers.
      }
    }
  }

  clear(): void {
    this.subscriptions.clear();
  }
}

const projectSnapshot = (
  source: OverlayProjectionSource,
  subscription: Subscription,
): Readonly<OverlayProjectionSnapshot> => {
  const matching = source.entities
    .filter((entity) => matches(entity, subscription))
    .sort((left, right) => left.id.localeCompare(right.id));
  const entities = matching
    .slice(0, subscription.maxEntities)
    .map((entity) => projectEntity(entity, source));
  return Object.freeze({
    sampledAtMs: source.sampledAtMs,
    tick: source.tick,
    canvasSize: Object.freeze({ ...source.canvasSize }),
    viewport: Object.freeze({ ...source.viewport }),
    entities: Object.freeze(entities),
    matchedEntities: matching.length,
    truncated: matching.length > entities.length,
  });
};

const matches = (entity: Readonly<RenderEntity>, subscription: Subscription): boolean =>
  (!subscription.entityIds || subscription.entityIds.has(entity.id)) &&
  (!subscription.kinds || subscription.kinds.has(entity.kind)) &&
  (!subscription.definitionIds || subscription.definitionIds.has(entity.definitionId));

const projectEntity = (
  entity: Readonly<RenderEntity>,
  source: OverlayProjectionSource,
): Readonly<OverlayEntityProjection> => {
  const point = projectOverlayPoint(entity, source.canvasSize, source.viewport);
  return Object.freeze({
    entityId: entity.id,
    kind: entity.kind,
    definitionId: entity.definitionId,
    world: point.world,
    screen: point.screen,
    rotation: entity.rotation,
    visible: entity.respawning !== true,
    inCanvas: point.inCanvas,
    inViewport: point.inViewport,
    disabled: entity.disabled === true,
    quarantined: entity.quarantined === true,
  });
};

/** Projects a consumer-owned world anchor without exposing the mutable camera. */
export const projectOverlayPoint = (
  point: Readonly<{ x: number; y: number; z?: number }>,
  canvasSize: Readonly<{ width: number; height: number }>,
  viewport: Readonly<OverlayViewportProjection>,
): Readonly<OverlayPointProjection> => {
  const z = point.z ?? 0;
  const screen = frozenPoint(
    viewport.offsetX + point.x * viewport.scale,
    viewport.offsetY + (point.y - z) * viewport.scale,
  );
  return Object.freeze({
    world: Object.freeze({ x: point.x, y: point.y, z }),
    screen,
    inCanvas: point.x >= 0 && point.x <= canvasSize.width &&
      point.y >= 0 && point.y <= canvasSize.height,
    inViewport: screen.x >= 0 && screen.x <= viewport.width &&
      screen.y >= 0 && screen.y <= viewport.height,
  });
};

const frozenPoint = (x: number, y: number): Readonly<Vec2> => Object.freeze({ x, y });

const assertFiniteRange = (
  name: string,
  value: number,
  exclusiveMinimum: number,
  maximum: number,
): void => {
  if (!Number.isFinite(value) || value <= exclusiveMinimum || value > maximum) {
    throw new RangeError(`${name} must be > ${exclusiveMinimum} and <= ${maximum}`);
  }
};

const assertIntegerRange = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
};

const assertFilterBound = (name: string, values?: readonly string[]): void => {
  if (values && values.length > MAX_OVERLAY_ENTITIES) {
    throw new RangeError(`${name} may contain at most ${MAX_OVERLAY_ENTITIES} values`);
  }
};
