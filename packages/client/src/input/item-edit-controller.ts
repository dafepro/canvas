import type { ItemDefinition, Transform, Vec2 } from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";

export interface ItemEditState {
  selectedEntityId?: string;
  ghost?: { entityId: string; definitionId: string; transform: Transform };
}

export interface ItemEditControllerOptions {
  enabled(): boolean;
  pick(point: Vec2): RenderEntity | undefined;
  toWorld(point: Vec2): Vec2;
  onPreview(entityId: string, transform: Transform): void;
  onCommit(entityId: string, transform: Transform): void;
  onChange(state: ItemEditState): void;
}

interface PresentedTransform {
  transform: Transform;
  committedAtMs?: number;
}

const transformMatches = (entity: RenderEntity, transform: Transform): boolean =>
  Math.abs(entity.x - transform.x) < 0.001 &&
  Math.abs(entity.y - transform.y) < 0.001 &&
  Math.abs(entity.rotation - transform.rotation) < 0.001 &&
  Math.abs((entity.scale ?? 1) - (transform.scale ?? 1)) < 0.001 &&
  Math.abs((entity.z ?? 0) - (transform.z ?? 0)) < 0.001;

/**
 * Keeps an owner's direct manipulation at display cadence while the durable
 * preview remains rate-limited. A committed pose is held until canonical state
 * catches up, preventing a one-frame snap back after pointer-up.
 */
export class ItemEditPresentation {
  private readonly transforms = new Map<string, PresentedTransform>();

  constructor(private readonly commitTimeoutMs = 1_500) {}

  preview(entityId: string, transform: Transform): void {
    this.transforms.set(entityId, { transform: { ...transform } });
  }

  commit(entityId: string, transform: Transform, nowMs = performance.now()): void {
    this.transforms.set(entityId, {
      transform: { ...transform },
      committedAtMs: nowMs,
    });
  }

  cancelPreview(entityId: string): void {
    if (this.transforms.get(entityId)?.committedAtMs === undefined) {
      this.transforms.delete(entityId);
    }
  }

  apply(entities: RenderEntity[], nowMs = performance.now()): RenderEntity[] {
    if (this.transforms.size === 0) return entities;
    let changed = false;
    const presented = entities.map((entity) => {
      const local = this.transforms.get(entity.id);
      if (!local) return entity;
      if (local.committedAtMs !== undefined) {
        if (transformMatches(entity, local.transform)) {
          this.transforms.delete(entity.id);
          return entity;
        }
        if (nowMs - local.committedAtMs >= this.commitTimeoutMs) {
          this.transforms.delete(entity.id);
          return entity;
        }
      }
      changed = true;
      return { ...entity, ...local.transform };
    });
    return changed ? presented : entities;
  }

  clear(): void {
    this.transforms.clear();
  }
}

/** Finds the topmost owned item whose rotated visual bounds contain a point. */
export const findOwnedItemAt = (
  entities: RenderEntity[],
  definitions: ItemDefinition[],
  point: Vec2,
  userId: string,
): RenderEntity | undefined => {
  const byId = new Map(definitions.map((definition) => [definition.definitionId, definition]));
  const candidates = entities
    .filter(
      (entity) =>
        entity.kind === "item" &&
        entity.ownerUserId === userId &&
        entity.respawning !== true,
    )
    .sort(
      (left, right) =>
        (byId.get(right.definitionId)?.visual.zIndex ?? 0) -
        (byId.get(left.definitionId)?.visual.zIndex ?? 0),
    );

  for (const entity of candidates) {
    const size = byId.get(entity.definitionId)?.visual.size ?? { width: 2, height: 2 };
    const dx = point.x - entity.x;
    const dy = point.y - entity.y;
    const cosine = Math.cos(entity.rotation);
    const sine = Math.sin(entity.rotation);
    const localX = cosine * dx + sine * dy;
    const localY = -sine * dx + cosine * dy;
    const scale = entity.scale ?? 1;
    if (
      Math.abs(localX) <= (size.width * scale) / 2 &&
      Math.abs(localY) <= (size.height * scale) / 2
    ) {
      return entity;
    }
  }
  return undefined;
};

/**
 * Spec 14.2. Owns the local edit gesture only. The session still rate-limits,
 * validates through the server, and applies accepted transforms on the host.
 */
export class ItemEditController {
  private selected?: RenderEntity;
  private pendingTap?: {
    pointerId: number;
    entity: RenderEntity;
    originLocal: Vec2;
    moved: boolean;
  };
  private drag?: {
    pointerId: number;
    entityId: string;
    definitionId: string;
    originLocal: Vec2;
    offset: Vec2;
    transform: Transform;
    moved: boolean;
  };
  private readonly detach: () => void;

  constructor(
    private readonly element: HTMLElement,
    private readonly options: ItemEditControllerOptions,
  ) {
    const onDown = (event: PointerEvent) => {
      if (!this.options.enabled()) return;
      const local = this.toLocal(event);
      const selected = this.options.pick(local);
      const wasSelected = selected !== undefined && this.selected?.id === selected.id;
      if (!selected) {
        this.selected = undefined;
        this.pendingTap = undefined;
        this.drag = undefined;
        this.emit();
        return;
      }

      // Selection is decided on pointer-up. Starting on an item and dragging
      // away is not a tap, so it must neither open editing nor move the item.
      if (!wasSelected) {
        this.pendingTap = {
          pointerId: event.pointerId,
          entity: selected,
          originLocal: local,
          moved: false,
        };
        this.drag = undefined;
        this.element.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const world = this.options.toWorld(local);
      const transform: Transform = {
        x: selected.x,
        y: selected.y,
        rotation: selected.rotation,
        scale: selected.scale ?? 1,
        z: selected.z,
      };
      this.drag = {
        pointerId: event.pointerId,
        entityId: selected.id,
        definitionId: selected.definitionId,
        originLocal: local,
        offset: { x: selected.x - world.x, y: selected.y - world.y },
        transform,
        moved: false,
      };
      this.element.setPointerCapture(event.pointerId);
      event.preventDefault();
      this.emit();
    };

    const onMove = (event: PointerEvent) => {
      const pendingTap = this.pendingTap;
      if (pendingTap?.pointerId === event.pointerId) {
        const local = this.toLocal(event);
        if (
          Math.hypot(
            local.x - pendingTap.originLocal.x,
            local.y - pendingTap.originLocal.y,
          ) >= 3
        ) {
          pendingTap.moved = true;
        }
        event.preventDefault();
        return;
      }
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const local = this.toLocal(event);
      if (
        !drag.moved &&
        Math.hypot(local.x - drag.originLocal.x, local.y - drag.originLocal.y) < 3
      ) {
        return;
      }
      drag.moved = true;
      const world = this.options.toWorld(local);
      drag.transform = {
        ...drag.transform,
        x: world.x + drag.offset.x,
        y: world.y + drag.offset.y,
      };
      this.options.onPreview(drag.entityId, drag.transform);
      event.preventDefault();
      this.emit();
    };

    const onUp = (event: PointerEvent) => {
      const pendingTap = this.pendingTap;
      if (pendingTap?.pointerId === event.pointerId) {
        if (this.element.hasPointerCapture(event.pointerId)) {
          this.element.releasePointerCapture(event.pointerId);
        }
        this.pendingTap = undefined;
        if (!pendingTap.moved) {
          this.selected = pendingTap.entity;
          this.emit();
        }
        event.preventDefault();
        return;
      }
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.drag = undefined;
      if (drag.moved) this.options.onCommit(drag.entityId, drag.transform);
      event.preventDefault();
      this.emit();
    };

    const onCancel = (event: PointerEvent) => {
      const pendingTap = this.pendingTap;
      if (pendingTap?.pointerId === event.pointerId) {
        if (this.element.hasPointerCapture(event.pointerId)) {
          this.element.releasePointerCapture(event.pointerId);
        }
        this.pendingTap = undefined;
        return;
      }
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.drag = undefined;
      event.preventDefault();
      this.emit();
    };

    this.element.addEventListener("pointerdown", onDown);
    this.element.addEventListener("pointermove", onMove);
    this.element.addEventListener("pointerup", onUp);
    this.element.addEventListener("pointercancel", onCancel);
    this.detach = () => {
      this.element.removeEventListener("pointerdown", onDown);
      this.element.removeEventListener("pointermove", onMove);
      this.element.removeEventListener("pointerup", onUp);
      this.element.removeEventListener("pointercancel", onCancel);
    };
  }

  clear(): void {
    this.select(undefined);
  }

  /** Synchronizes a product-owned list/menu selection with pointer editing. */
  select(entity: RenderEntity | undefined): void {
    this.releasePointer(this.pendingTap?.pointerId);
    this.releasePointer(this.drag?.pointerId);
    this.pendingTap = undefined;
    this.drag = undefined;
    this.selected = entity;
    this.emit();
  }

  private emit(): void {
    const drag = this.drag;
    this.options.onChange({
      selectedEntityId: this.selected?.id,
      ghost: drag
        ? {
            entityId: drag.entityId,
            definitionId: drag.definitionId,
            transform: { ...drag.transform },
          }
        : undefined,
    });
  }

  private toLocal(event: PointerEvent): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private releasePointer(pointerId: number | undefined): void {
    if (pointerId !== undefined && this.element.hasPointerCapture(pointerId)) {
      this.element.releasePointerCapture(pointerId);
    }
  }

  destroy(): void {
    this.detach();
    this.releasePointer(this.pendingTap?.pointerId);
    this.releasePointer(this.drag?.pointerId);
    this.pendingTap = undefined;
    this.drag = undefined;
    this.selected = undefined;
  }
}
