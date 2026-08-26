import type { ItemDefinition, Transform, Vec2 } from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";
import type {
  PointerInteractionClaim,
  PointerInteractionSample,
  PointerInteractionStrategy,
} from "./pointer-interaction-coordinator.js";
import { pointerInteractionPriorities } from "./pointer-interaction-coordinator.js";

export interface ItemEditState {
  selectedEntityId?: string;
  ghost?: { entityId: string; definitionId: string; transform: Transform };
}

export interface ItemEditInteractionOptions {
  enabled(): boolean;
  pick(point: Vec2, preferredEntityId?: string): RenderEntity | undefined;
  onPreview(entityId: string, transform: Transform): void;
  onCommit(entityId: string, transform: Transform): void;
  onChange(state: ItemEditState): void;
}

interface PresentedTransform {
  editSessionId: string;
  entityId: string;
  transform: Transform;
  mutationId?: number;
  accepted?: {
    sceneRevision: number;
    transform?: Transform;
    deleted: boolean;
  };
}

export type ItemPresentationSettlement =
  | Readonly<{
      status: "accepted";
      mutationId: number;
      sceneRevision: number;
      item?: { entityId: string; transform: Transform };
      deletedEntityId?: string;
    }>
  | Readonly<{
      status: "rejected" | "cancelled" | "superseded";
      mutationId: number;
    }>;

const transformMatches = (entity: RenderEntity, transform: Transform): boolean =>
  Math.abs(entity.x - transform.x) < 0.001 &&
  Math.abs(entity.y - transform.y) < 0.001 &&
  Math.abs(entity.rotation - transform.rotation) < 0.001 &&
  Math.abs((entity.scale ?? 1) - (transform.scale ?? 1)) < 0.001 &&
  Math.abs((entity.z ?? 0) - (transform.z ?? 0)) < 0.001;

/**
 * Keeps an owner's direct manipulation at display cadence while the durable
 * preview remains rate-limited. A committed pose is held until its accepted
 * scene revision is visible in canonical state, preventing both snap-back and
 * timeout-based guesses about relay latency.
 */
export class ItemEditPresentation {
  private readonly transforms = new Map<string, PresentedTransform>();

  preview(editSessionId: string, entityId: string, transform: Transform): void {
    this.transforms.set(entityId, {
      editSessionId,
      entityId,
      transform: { ...transform },
    });
  }

  commit(
    editSessionId: string,
    mutationId: number,
    entityId: string,
    transform: Transform,
  ): void {
    this.transforms.set(entityId, {
      editSessionId,
      entityId,
      transform: { ...transform },
      mutationId,
    });
  }

  settle(outcome: ItemPresentationSettlement): void {
    for (const [entityId, presented] of this.transforms) {
      if (presented.mutationId !== outcome.mutationId) continue;
      if (outcome.status !== "accepted") {
        this.transforms.delete(entityId);
        return;
      }
      const acceptedEntityId = outcome.item?.entityId ?? outcome.deletedEntityId;
      if (acceptedEntityId !== presented.entityId) {
        this.transforms.delete(entityId);
        return;
      }
      presented.accepted = {
        sceneRevision: outcome.sceneRevision,
        transform: outcome.item ? { ...outcome.item.transform } : undefined,
        deleted: outcome.deletedEntityId === presented.entityId,
      };
      return;
    }
  }

  observeCanonical(sceneRevision: number, entities: readonly RenderEntity[]): void {
    if (this.transforms.size === 0) return;
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    for (const [entityId, presented] of this.transforms) {
      const accepted = presented.accepted;
      if (!accepted || sceneRevision < accepted.sceneRevision) continue;
      const canonical = byId.get(entityId);
      if (accepted.deleted ? !canonical : !!canonical && !!accepted.transform &&
        transformMatches(canonical, accepted.transform)) {
        this.transforms.delete(entityId);
      }
    }
  }

  endEdit(editSessionId: string): void {
    for (const [entityId, presented] of this.transforms) {
      if (presented.editSessionId === editSessionId && presented.mutationId === undefined) {
        this.transforms.delete(entityId);
      }
    }
  }

  apply(entities: RenderEntity[]): RenderEntity[] {
    if (this.transforms.size === 0) return entities;
    let changed = false;
    const presented = entities.map((entity) => {
      const local = this.transforms.get(entity.id);
      if (!local) return entity;
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
  preferredEntityId?: string,
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
      (left, right) => {
        if (left.id === preferredEntityId) return -1;
        if (right.id === preferredEntityId) return 1;
        return (
          (byId.get(right.definitionId)?.visual.zIndex ?? 0) -
          (byId.get(left.definitionId)?.visual.zIndex ?? 0)
        );
      },
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
 * Spec 14.2. Interprets the local edit gesture only. The session still rate-limits,
 * validates through the server, and applies accepted transforms on the host.
 */
export class ItemEditInteraction implements PointerInteractionStrategy {
  readonly id = "item-edit";
  readonly priority = pointerInteractionPriorities.itemEdit;

  private selected?: RenderEntity;
  private gesture?: {
    kind: "select" | "drag";
    entity: RenderEntity;
    entityId: string;
    definitionId: string;
    originLocal: Vec2;
    offset: Vec2;
    transform: Transform;
    moved: boolean;
  };

  constructor(private readonly options: ItemEditInteractionOptions) {}

  claim(sample: Readonly<PointerInteractionSample>): PointerInteractionClaim | undefined {
    if (!this.options.enabled()) return undefined;
    const entity = this.options.pick({ ...sample.local }, this.selected?.id);
    if (!entity) {
      this.selected = undefined;
      this.gesture = undefined;
      this.emit();
      return undefined;
    }

    const wasSelected = this.selected?.id === entity.id;
    if (!wasSelected) {
      this.gesture = {
        kind: "select",
        entity,
        entityId: entity.id,
        definitionId: entity.definitionId,
        originLocal: { ...sample.local },
        offset: { x: 0, y: 0 },
        transform: this.transform(entity),
        moved: false,
      };
    } else {
      const world = sample.world;
      if (!world) return undefined;
      this.selected = entity;
      this.gesture = {
        kind: "drag",
        entity,
        entityId: entity.id,
        definitionId: entity.definitionId,
        originLocal: { ...sample.local },
        offset: { x: entity.x - world.x, y: entity.y - world.y },
        transform: this.transform(entity),
        moved: false,
      };
    }

    return {
      kind: this.gesture.kind === "select" ? "item-select" : "item-drag",
      phase: () => this.gesture?.moved ? "active" : "pending",
      move: (next) => this.move(next),
      release: () => this.release(),
      cancel: () => this.cancelGesture(),
      suspend: () => {},
      resume: (next) => this.move(next),
    };
  }

  clear(): void {
    this.select(undefined);
  }

  /** Synchronizes a product-owned list/menu selection with pointer editing. */
  select(entity: RenderEntity | undefined): void {
    this.gesture = undefined;
    this.selected = entity;
    this.emit();
  }

  private emit(): void {
    const drag = this.gesture?.kind === "drag" ? this.gesture : undefined;
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

  private move(sample: Readonly<PointerInteractionSample>): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const distance = Math.hypot(
      sample.local.x - gesture.originLocal.x,
      sample.local.y - gesture.originLocal.y,
    );
    if (gesture.kind === "select") {
      if (distance >= 3) gesture.moved = true;
      return;
    }
    if (!gesture.moved && distance < 3) return;
    const world = sample.world;
    if (!world) return;
    gesture.moved = true;
    gesture.transform = {
      ...gesture.transform,
      x: world.x + gesture.offset.x,
      y: world.y + gesture.offset.y,
    };
    this.options.onPreview(gesture.entityId, gesture.transform);
    this.emit();
  }

  private release(): void {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (!gesture) return;
    if (gesture.kind === "select") {
      if (!gesture.moved) {
        this.selected = gesture.entity;
        this.emit();
      }
      return;
    }
    if (gesture.moved) this.options.onCommit(gesture.entityId, gesture.transform);
    this.emit();
  }

  private cancelGesture(): void {
    const changed = this.gesture?.kind === "drag" && this.gesture.moved;
    this.gesture = undefined;
    if (changed) this.emit();
  }

  private transform(entity: Readonly<RenderEntity>): Transform {
    return {
      x: entity.x,
      y: entity.y,
      rotation: entity.rotation,
      scale: entity.scale ?? 1,
      z: entity.z,
    };
  }
}
