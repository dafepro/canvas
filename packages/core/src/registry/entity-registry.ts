import type { Entity, EntityId } from "./components.js";

export type EntityEvent =
  | { type: "added"; entity: Entity }
  | { type: "removed"; entity: Entity };

/**
 * A small registry for the ~70 active entities of a room. Iteration order is
 * insertion order, which keeps host behavior processing reproducible (spec 8.4).
 */
export class EntityRegistry {
  private readonly entities = new Map<EntityId, Entity>();
  private readonly byTag = new Map<string, Set<EntityId>>();
  private readonly listeners = new Set<(event: EntityEvent) => void>();

  get size(): number {
    return this.entities.size;
  }

  add(entity: Entity): Entity {
    if (this.entities.has(entity.id)) {
      throw new Error(`entity ${entity.id} already exists`);
    }
    this.entities.set(entity.id, entity);
    for (const tag of entity.tags ?? []) this.indexTag(tag, entity.id);
    this.emit({ type: "added", entity });
    return entity;
  }

  remove(id: EntityId): Entity | undefined {
    const entity = this.entities.get(id);
    if (!entity) return undefined;
    this.entities.delete(id);
    for (const tag of entity.tags ?? []) this.byTag.get(tag)?.delete(id);
    this.emit({ type: "removed", entity });
    return entity;
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  require(id: EntityId): Entity {
    const entity = this.entities.get(id);
    if (!entity) throw new Error(`unknown entity ${id}`);
    return entity;
  }

  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  /** Insertion-ordered iteration. */
  all(): Iterable<Entity> {
    return this.entities.values();
  }

  ids(): EntityId[] {
    return [...this.entities.keys()];
  }

  ofKind(kind: Entity["kind"]): Entity[] {
    return [...this.entities.values()].filter((e) => e.kind === kind);
  }

  /** Entities that carry a given component key. */
  withComponent<K extends keyof Entity>(key: K): Entity[] {
    return [...this.entities.values()].filter((e) => e[key] !== undefined);
  }

  taggedWith(tag: string): Entity[] {
    const ids = this.byTag.get(tag);
    if (!ids) return [];
    return [...ids].map((id) => this.entities.get(id)!).filter(Boolean);
  }

  addTag(id: EntityId, tag: string): void {
    const entity = this.require(id);
    entity.tags = entity.tags ?? new Set();
    entity.tags.add(tag);
    this.indexTag(tag, id);
  }

  clear(): void {
    for (const id of [...this.entities.keys()]) this.remove(id);
    this.byTag.clear();
  }

  subscribe(listener: (event: EntityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private indexTag(tag: string, id: EntityId): void {
    let set = this.byTag.get(tag);
    if (!set) {
      set = new Set();
      this.byTag.set(tag, set);
    }
    set.add(id);
  }

  private emit(event: EntityEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
