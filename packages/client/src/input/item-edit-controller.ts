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
    if (Math.abs(localX) <= size.width / 2 && Math.abs(localY) <= size.height / 2) {
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
      this.selected = selected;
      if (!selected) {
        this.drag = undefined;
        this.emit();
        return;
      }

      const world = this.options.toWorld(local);
      const transform: Transform = {
        x: selected.x,
        y: selected.y,
        rotation: selected.rotation,
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

    this.element.addEventListener("pointerdown", onDown);
    this.element.addEventListener("pointermove", onMove);
    this.element.addEventListener("pointerup", onUp);
    this.element.addEventListener("pointercancel", onUp);
    this.detach = () => {
      this.element.removeEventListener("pointerdown", onDown);
      this.element.removeEventListener("pointermove", onMove);
      this.element.removeEventListener("pointerup", onUp);
      this.element.removeEventListener("pointercancel", onUp);
    };
  }

  clear(): void {
    this.drag = undefined;
    this.selected = undefined;
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

  destroy(): void {
    this.detach();
    this.drag = undefined;
    this.selected = undefined;
  }
}
