import {
  resolveItemConfig,
  type CanvasDefinition,
  type CanvasSnapshot,
  type ItemDefinition,
  type SnapshotItem,
  type Transform,
  type Vec2,
} from "@canvas-physics/core";
import {
  DurableCommandKind,
  fromJsonBytes,
  toJsonBytes,
  type DurableCommand,
} from "@canvas-physics/protocol";
import type { RenderEntity, SimulationRequest } from "../../simulation/messages.js";
import {
  systemSessionClock,
  type SessionClock,
  type SessionTimeout,
} from "./session-clock.js";

export interface DurableCommandContext {
  readonly clientId: string;
  readonly userId: string;
  readonly sceneRevision: number;
  readonly isHost: boolean;
  readonly canvas?: CanvasDefinition;
}

export type DurableCommandEffect =
  | { readonly type: "send"; readonly command: DurableCommand }
  | { readonly type: "simulate"; readonly request: SimulationRequest }
  | {
      readonly type: "rejected";
      readonly command: DurableCommand;
      readonly reason: string;
    };

export interface DurableCommandSessionOptions {
  readonly definitions: readonly ItemDefinition[];
  readonly previewHz?: number;
  readonly clock?: SessionClock;
  readonly context: () => DurableCommandContext;
  readonly emit: (effect: DurableCommandEffect) => void;
}

/** Sole owner of durable item command construction, metadata, and preview timing. */
export class DurableCommandSession {
  private readonly definitions: readonly ItemDefinition[];
  private readonly previewIntervalMs: number;
  private readonly clock: SessionClock;
  private readonly context: () => DurableCommandContext;
  private readonly emit: (effect: DurableCommandEffect) => void;
  private readonly metadataById = new Map<
    string,
    Readonly<{
      definitionId: string;
      ownerUserId: string;
      resolvedConfig: unknown;
    }>
  >();
  private previewTimer?: SessionTimeout;
  private pendingPreview?: { entityId: string; transform: Transform };
  private lastPreviewSentAt = Number.NEGATIVE_INFINITY;
  private commandCounter = 0;

  constructor(options: DurableCommandSessionOptions) {
    this.definitions = options.definitions;
    this.previewIntervalMs = 1_000 / Math.max(1, options.previewHz ?? 15);
    this.clock = options.clock ?? systemSessionClock;
    this.context = options.context;
    this.emit = options.emit;
  }

  get itemCount(): number {
    return this.metadataById.size;
  }

  get itemEntityIds(): readonly string[] {
    return Object.freeze([...this.metadataById.keys()]);
  }

  loadSnapshot(snapshot: CanvasSnapshot): void {
    this.metadataById.clear();
    for (const item of snapshot.items) this.remember(item);
  }

  decorate(entity: RenderEntity): RenderEntity {
    if (entity.kind !== "item") return entity;
    const metadata = this.metadataById.get(entity.id);
    if (!metadata) return entity;
    return {
      ...entity,
      definitionId: entity.definitionId || metadata.definitionId,
      ownerUserId: metadata.ownerUserId,
      resolvedConfig: metadata.resolvedConfig,
    };
  }

  resetConnection(): void {
    this.clearPreview();
    this.lastPreviewSentAt = Number.NEGATIVE_INFINITY;
  }

  destroy(): void {
    this.clearPreview();
    this.metadataById.clear();
  }

  spawnItem(definitionId: string, at: Vec2, rotation = 0, scale = 1): void {
    const definition = this.definitions.find(
      (candidate) => candidate.definitionId === definitionId,
    );
    const canvas = this.context().canvas;
    if (!definition || !canvas) return;
    const config = resolveItemConfig(
      definition as ItemDefinition<Record<string, unknown>>,
      {
        width: canvas.size.width,
        height: canvas.size.height,
        orientation: canvas.orientation,
      },
    );
    this.send({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_SPAWN_ITEM,
      entityId: "",
      definitionId,
      definitionVersion: definition.version,
      position: at,
      rotation,
      scale,
      z: 0,
      configJson: toJsonBytes(config),
      preview: false,
      isolated: false,
      collisionsEnabled: true,
    });
  }

  moveItem(entityId: string, transform: Transform, preview = false): void {
    this.transformItem(entityId, transform, preview);
  }

  transformItem(entityId: string, transform: Transform, preview = false): void {
    if (preview) {
      this.queuePreview(entityId, transform);
      return;
    }
    this.clearPreview();
    this.sendMove(entityId, transform, false);
  }

  rotateItem(entityId: string, rotation: number): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_ROTATE_ITEM),
      rotation,
    });
  }

  scaleItem(entityId: string, scale: number): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_SCALE_ITEM),
      scale,
    });
  }

  setItemConfig(entityId: string, config: unknown): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_SET_CONFIG),
      configJson: toJsonBytes(config),
    });
  }

  setItemIsolation(entityId: string, isolated: boolean): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_SET_ITEM_ISOLATION),
      isolated,
    });
  }

  setItemCollisionsEnabled(entityId: string, enabled: boolean): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_SET_ITEM_COLLISIONS),
      collisionsEnabled: enabled,
    });
  }

  deleteItem(entityId: string): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_DELETE_ITEM),
      position: { x: 0, y: 0 },
    });
  }

  accept(command: DurableCommand, item?: SnapshotItem): void {
    if (command.kind === DurableCommandKind.DURABLE_DELETE_ITEM) {
      this.metadataById.delete(command.entityId);
    } else if (item) {
      this.remember(item);
    }
    this.applyAccepted(command, item);
  }

  acceptPreview(command: DurableCommand): void {
    this.applyAccepted(command);
  }

  reject(command: DurableCommand, reason: string): void {
    this.emit(Object.freeze({ type: "rejected", command, reason }));
  }

  private remember(item: SnapshotItem): void {
    this.metadataById.set(item.entityId, Object.freeze({
      definitionId: item.definitionId,
      ownerUserId: item.ownerUserId,
      resolvedConfig: immutableConfig(item.resolvedConfig),
    }));
  }

  private queuePreview(entityId: string, transform: Transform): void {
    const now = this.clock.now();
    const remaining = this.previewIntervalMs - (now - this.lastPreviewSentAt);
    if (remaining <= 0) {
      this.lastPreviewSentAt = now;
      this.sendMove(entityId, transform, true);
      return;
    }
    this.pendingPreview = { entityId, transform: { ...transform } };
    if (this.previewTimer !== undefined) return;
    this.previewTimer = this.clock.setTimeout(() => {
      this.previewTimer = undefined;
      const pending = this.pendingPreview;
      this.pendingPreview = undefined;
      if (!pending) return;
      this.lastPreviewSentAt = this.clock.now();
      this.sendMove(pending.entityId, pending.transform, true);
    }, remaining);
  }

  private clearPreview(): void {
    if (this.previewTimer !== undefined) this.clock.clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.pendingPreview = undefined;
  }

  private sendMove(entityId: string, transform: Transform, preview: boolean): void {
    this.send({
      ...this.base(entityId, DurableCommandKind.DURABLE_MOVE_ITEM),
      position: { x: transform.x, y: transform.y },
      rotation: transform.rotation,
      scale: transform.scale ?? 1,
      z: transform.z ?? 0,
      preview,
    });
  }

  private base(entityId: string, kind: DurableCommandKind): DurableCommand {
    return {
      commandId: this.nextCommandId(),
      kind,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: undefined,
      rotation: 0,
      scale: 0,
      z: 0,
      configJson: new Uint8Array(),
      preview: false,
      isolated: false,
      collisionsEnabled: false,
    };
  }

  private nextCommandId(): string {
    return `${this.context().clientId}-${++this.commandCounter}`;
  }

  private send(command: DurableCommand): void {
    this.emit(Object.freeze({ type: "send", command }));
  }

  private simulate(request: SimulationRequest): void {
    this.emit(Object.freeze({ type: "simulate", request }));
  }

  private applyAccepted(command: DurableCommand, item?: SnapshotItem): void {
    const context = this.context();
    if (!context.isHost) return;
    switch (command.kind) {
      case DurableCommandKind.DURABLE_SPAWN_ITEM:
        this.simulate({
          type: "addItem",
          instance: {
            entityId: command.entityId,
            canvasId: context.canvas?.id ?? "",
            definitionId: command.definitionId,
            definitionVersion: command.definitionVersion,
            ownerUserId: item?.ownerUserId ?? context.userId,
            transform: item?.transform ?? {
              x: command.position?.x ?? 0,
              y: command.position?.y ?? 0,
              rotation: command.rotation,
              scale: command.scale || 1,
              z: command.z || undefined,
            },
            resolvedConfig:
              item?.resolvedConfig ??
              JSON.parse(
                new TextDecoder().decode(
                  command.configJson || new Uint8Array([123, 125]),
                ),
              ),
            createdAt: new Date().toISOString(),
            sceneRevision: context.sceneRevision,
            isolated: item?.isolated ?? command.isolated,
            collisionsDisabled: item?.collisionsDisabled,
          },
        });
        break;
      case DurableCommandKind.DURABLE_DELETE_ITEM:
        this.simulate({ type: "removeItem", entityId: command.entityId });
        break;
      case DurableCommandKind.DURABLE_MOVE_ITEM:
      case DurableCommandKind.DURABLE_ROTATE_ITEM:
      case DurableCommandKind.DURABLE_SCALE_ITEM: {
        const transform = item?.transform ?? (
          command.kind === DurableCommandKind.DURABLE_MOVE_ITEM
            ? {
                x: command.position?.x ?? 0,
                y: command.position?.y ?? 0,
                rotation: command.rotation,
                scale: command.scale || 1,
                z: command.z || undefined,
              }
            : undefined
        );
        if (transform) {
          this.simulate({
            type: "moveItem",
            entityId: command.entityId,
            transform,
            preview: command.preview,
          });
        }
        break;
      }
      case DurableCommandKind.DURABLE_SET_CONFIG: {
        const config = item?.resolvedConfig ?? fromJsonBytes(command.configJson);
        if (config !== undefined) {
          this.simulate({ type: "setItemConfig", entityId: command.entityId, config });
        }
        break;
      }
      case DurableCommandKind.DURABLE_SET_ITEM_ISOLATION:
        this.simulate({
          type: "setItemIsolation",
          entityId: command.entityId,
          isolated: item?.isolated ?? command.isolated,
        });
        break;
      case DurableCommandKind.DURABLE_SET_ITEM_COLLISIONS:
        this.simulate({
          type: "setItemCollisions",
          entityId: command.entityId,
          enabled: !(item?.collisionsDisabled ?? !command.collisionsEnabled),
        });
        break;
    }
  }
}

const immutableConfig = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableConfig));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableConfig(item)]),
      ),
    );
  }
  return value;
};
