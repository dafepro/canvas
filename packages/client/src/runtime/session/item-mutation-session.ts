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
  ItemEditSessionStatus,
  ItemMutationKind,
  ItemMutationRejectCode as WireRejectCode,
  toJsonBytes,
  type BeginItemEdit,
  type EndItemEdit,
  type ItemEditPreview,
  type ItemEditSessionResult,
  type ItemMutation,
  type ItemMutationResult,
  type RenewItemEdit,
} from "@canvas-physics/protocol";
import type { RenderEntity, SimulationRequest } from "../../simulation/messages.js";
import { ItemEditPresentation } from "../../input/item-edit-interaction.js";
import {
  systemSessionClock,
  type SessionClock,
  type SessionTimeout,
} from "./session-clock.js";
import {
  ObserverSet,
  type Observer,
  type ObserverErrorHandler,
  type SubscriptionOptions,
} from "../observers.js";

export interface ItemMutationContext {
  readonly clientId: string;
  readonly userId: string;
  readonly sceneRevision: number;
  readonly isHost: boolean;
  readonly canvas?: CanvasDefinition;
}

export type ItemMutationEffect =
  | { readonly type: "sendMutation"; readonly mutation: ItemMutation }
  | { readonly type: "beginEdit"; readonly request: BeginItemEdit }
  | { readonly type: "renewEdit"; readonly request: RenewItemEdit }
  | { readonly type: "endEdit"; readonly request: EndItemEdit }
  | { readonly type: "sendPreview"; readonly preview: ItemEditPreview }
  | { readonly type: "simulate"; readonly request: SimulationRequest };

export interface ItemMutationSessionOptions {
  readonly clientSessionId?: string;
  readonly definitions: readonly ItemDefinition[];
  readonly previewHz?: number;
  readonly clock?: SessionClock;
  readonly context: () => ItemMutationContext;
  readonly emit: (effect: ItemMutationEffect) => void;
  readonly onObserverError?: ObserverErrorHandler;
}

export type ItemMutationRejectCode =
  | "malformed"
  | "not_found"
  | "system_owned"
  | "not_owner"
  | "edit_in_use"
  | "edit_expired"
  | "stale_item_revision"
  | "outside_canvas"
  | "scale_out_of_range"
  | "definition"
  | "config"
  | "capacity"
  | "receipt_expired"
  | "internal"
  | "application_policy"
  | "application_unavailable"
  | "application_correlation_conflict";

/** Private product metadata consumed only at the server mutation boundary. */
export interface ItemMutationOptions {
  readonly authorizationEvidence?: Uint8Array;
  readonly applicationCorrelationId?: string;
}

export type ItemMutationRequest =
  | { readonly kind: "spawn"; readonly definitionId: string; readonly transform: Transform }
  | { readonly kind: "transform"; readonly entityId: string; readonly transform: Transform }
  | { readonly kind: "rotation"; readonly entityId: string; readonly rotation: number }
  | { readonly kind: "scale"; readonly entityId: string; readonly scale: number }
  | { readonly kind: "config"; readonly entityId: string; readonly config: unknown }
  | { readonly kind: "isolation"; readonly entityId: string; readonly isolated: boolean }
  | { readonly kind: "collisions"; readonly entityId: string; readonly enabled: boolean }
  | { readonly kind: "delete"; readonly entityId: string };

export type ItemMutationOutcome =
  | Readonly<{
      status: "accepted";
      mutationId: number;
      sceneRevision: number;
      itemRevision: number;
      item?: SnapshotItem;
      deletedEntityId?: string;
    }>
  | Readonly<{
      status: "rejected";
      mutationId: number;
      code: ItemMutationRejectCode;
      message?: string;
      authoritativeItem?: SnapshotItem;
    }>
  | Readonly<{
      status: "cancelled" | "superseded";
      mutationId: number;
      reason: string;
    }>;

export interface ItemMutationReceipt {
  readonly clientSessionId: string;
  readonly mutationId: number;
  readonly editSessionId?: string;
  readonly settled: Promise<ItemMutationOutcome>;
}

export interface ItemMutationSnapshot {
  readonly pending: readonly Readonly<{
    mutationId: number;
    editSessionId?: string;
    entityId?: string;
    kind: ItemMutationRequest["kind"];
    sent: boolean;
  }>[];
  readonly lastOutcome?: ItemMutationOutcome;
}

export type ItemEditEndOutcome = Readonly<{
  status: "ended" | "rejected" | "expired" | "superseded";
  editSessionId: string;
  entityId: string;
  code?: ItemMutationRejectCode;
  message?: string;
}>;

export interface ItemEditHandle {
  readonly editSessionId: string;
  readonly entityId: string;
  readonly state: "opening" | "active" | "ending" | "ended";
  readonly ended: Promise<ItemEditEndOutcome>;
  preview(transform: Transform): void;
  mutate(request: ItemMutationRequest, options?: ItemMutationOptions): ItemMutationReceipt;
  end(): void;
  cancel(): void;
}

interface PendingMutation {
  readonly mutationId: number;
  readonly request: ItemMutationRequest;
  readonly editSessionId?: string;
  readonly options?: ItemMutationOptions;
  readonly queueKey: string;
  readonly receipt: ItemMutationReceipt;
  readonly resolve: (outcome: ItemMutationOutcome) => void;
  mutation?: ItemMutation;
  sent: boolean;
}

interface EditRecord {
  readonly editSessionId: string;
  readonly entityId: string;
  readonly handle: ItemEditHandle;
  readonly ended: Promise<ItemEditEndOutcome>;
  readonly resolveEnded: (outcome: ItemEditEndOutcome) => void;
  state: ItemEditHandle["state"];
  itemRevision: number;
  leaseTimer?: SessionTimeout;
  previewTimer?: SessionTimeout;
  pendingPreview?: Transform;
  lastPreviewSentAt: number;
  previewSequence: number;
}

const freezeItem = (item: SnapshotItem | undefined): SnapshotItem | undefined =>
  item ? Object.freeze({ ...item, transform: Object.freeze({ ...item.transform }) }) : undefined;

const entityIdOf = (request: ItemMutationRequest): string | undefined =>
  request.kind === "spawn" ? undefined : request.entityId;

const randomSessionId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Sole owner of durable mutation identities, per-item queues, edit leases,
 * preview timing, canonical item metadata, and terminal receipts.
 */
export class ItemMutationSession {
  readonly clientSessionId: string;

  private readonly definitions: readonly ItemDefinition[];
  private readonly previewIntervalMs: number;
  private readonly clock: SessionClock;
  private readonly context: () => ItemMutationContext;
  private readonly emit: (effect: ItemMutationEffect) => void;
  private readonly metadataById = new Map<string, SnapshotItem>();
  private readonly pendingById = new Map<number, PendingMutation>();
  private readonly mutationQueues = new Map<string, PendingMutation[]>();
  private readonly editsById = new Map<string, EditRecord>();
  private readonly editByEntity = new Map<string, EditRecord>();
  private readonly mutationObservers: ObserverSet<ItemMutationSnapshot>;
  private readonly presentation = new ItemEditPresentation();
  private mutationCounter = 0;
  private editCounter = 0;
  private lastOutcome?: ItemMutationOutcome;
  private connectionReadyValue = true;

  constructor(options: ItemMutationSessionOptions) {
    this.clientSessionId = options.clientSessionId ?? randomSessionId();
    this.definitions = options.definitions;
    this.previewIntervalMs = 1_000 / Math.max(1, options.previewHz ?? 15);
    this.clock = options.clock ?? systemSessionClock;
    this.context = options.context;
    this.emit = options.emit;
    this.mutationObservers = new ObserverSet(options.onObserverError);
  }

  get itemCount(): number { return this.metadataById.size; }

  get itemEntityIds(): readonly string[] {
    return Object.freeze([...this.metadataById.keys()]);
  }

  itemRevision(entityId: string): number | undefined {
    return this.metadataById.get(entityId)?.itemRevision;
  }

  subscribeMutations(
    observer: Observer<ItemMutationSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.mutationObservers.subscribe(observer, options, () => this.mutationSnapshot());
  }

  loadSnapshot(snapshot: CanvasSnapshot): void {
    this.metadataById.clear();
    for (const item of snapshot.items) this.remember(item);
  }

  connectionReady(): void {
    this.connectionReadyValue = true;
    for (const queue of this.mutationQueues.values()) {
      const pending = queue[0];
      if (pending && !pending.sent) this.sendPending(pending);
    }
  }

  decorate(entity: RenderEntity): RenderEntity {
    if (entity.kind !== "item") return entity;
    const item = this.metadataById.get(entity.id);
    if (!item) return entity;
    return {
      ...entity,
      definitionId: entity.definitionId || item.definitionId,
      ownerUserId: item.ownerUserId,
      itemRevision: item.itemRevision,
    };
  }

  observeCanonical(sceneRevision: number, entities: readonly RenderEntity[]): void {
    this.presentation.observeCanonical(sceneRevision, entities);
  }

  present(entities: RenderEntity[]): RenderEntity[] {
    return this.presentation.apply(entities);
  }

  resetConnection(): void {
    this.connectionReadyValue = false;
    for (const pending of this.pendingById.values()) pending.sent = false;
    for (const edit of [...this.editsById.values()]) {
      this.finishEdit(edit, "superseded", undefined, "connection generation changed");
    }
    this.publishMutations();
  }

  destroy(): void {
    for (const edit of [...this.editsById.values()]) {
      this.finishEdit(edit, "superseded", undefined, "session destroyed");
    }
    for (const pending of [...this.pendingById.values()]) {
      this.settleMutation(pending, Object.freeze({
        status: "cancelled",
        mutationId: pending.mutationId,
        reason: "session destroyed",
      }));
    }
    this.metadataById.clear();
    this.presentation.clear();
    this.mutationObservers.clear();
  }

  spawnItem(
    definitionId: string,
    at: Vec2,
    rotation = 0,
    scale = 1,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue({
      kind: "spawn",
      definitionId,
      transform: { x: at.x, y: at.y, rotation, scale },
    }, undefined, options);
  }

  moveItem(
    entityId: string,
    transform: Transform,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    const editSessionId = typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined;
    const mutationOptions = typeof editSessionOrOptions === "string"
      ? options
      : editSessionOrOptions;
    return this.enqueue(
      { kind: "transform", entityId, transform: { ...transform } },
      editSessionId,
      mutationOptions,
    );
  }

  rotateItem(
    entityId: string,
    rotation: number,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "rotation", entityId, rotation },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  scaleItem(
    entityId: string,
    scale: number,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "scale", entityId, scale },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  setItemConfig(
    entityId: string,
    config: unknown,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "config", entityId, config },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  setItemIsolation(
    entityId: string,
    isolated: boolean,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "isolation", entityId, isolated },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  setItemCollisionsEnabled(
    entityId: string,
    enabled: boolean,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "collisions", entityId, enabled },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  deleteItem(
    entityId: string,
    editSessionOrOptions?: string | ItemMutationOptions,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    return this.enqueue(
      { kind: "delete", entityId },
      typeof editSessionOrOptions === "string" ? editSessionOrOptions : undefined,
      typeof editSessionOrOptions === "string" ? options : editSessionOrOptions,
    );
  }

  beginItemEdit(entityId: string): ItemEditHandle {
    const existing = this.editByEntity.get(entityId);
    if (existing && existing.state !== "ended") return existing.handle;

    const editSessionId = `edit-${++this.editCounter}`;
    let resolveEnded!: (outcome: ItemEditEndOutcome) => void;
    const ended = new Promise<ItemEditEndOutcome>((resolve) => { resolveEnded = resolve; });
    const record = {} as EditRecord;
    const handle: ItemEditHandle = Object.freeze({
      editSessionId,
      entityId,
      get state() { return record.state; },
      ended,
      preview: (transform: Transform) => this.previewEdit(record, transform),
      mutate: (request: ItemMutationRequest, options?: ItemMutationOptions) => {
        const target = entityIdOf(request);
        if (!target || target !== entityId) {
          return this.localRejection(request, editSessionId, "malformed",
            "an edit handle can mutate only its selected item");
        }
        this.clearPendingPreview(record);
        const receipt = this.enqueue(request, editSessionId, options);
        if (request.kind === "transform") {
          this.presentation.commit(
            editSessionId,
            receipt.mutationId,
            entityId,
            request.transform,
          );
          void receipt.settled.then((outcome) => this.presentation.settle(outcome));
        }
        return receipt;
      },
      end: () => this.requestEditEnd(record, false),
      cancel: () => this.requestEditEnd(record, true),
    });
    Object.assign(record, {
      editSessionId,
      entityId,
      handle,
      ended,
      resolveEnded,
      state: "opening",
      itemRevision: this.metadataById.get(entityId)?.itemRevision ?? 0,
      lastPreviewSentAt: Number.NEGATIVE_INFINITY,
      previewSequence: 0,
    } satisfies EditRecord);
    this.editsById.set(editSessionId, record);
    this.editByEntity.set(entityId, record);

    const item = this.metadataById.get(entityId);
    if (!item) {
      this.finishEdit(record, "rejected", "not_found", "item is not in the canonical snapshot");
      return handle;
    }
    this.emit(Object.freeze({
      type: "beginEdit",
      request: Object.freeze({
        clientSessionId: this.clientSessionId,
        editSessionId,
        entityId,
        observedItemRevision: item.itemRevision,
      }),
    }));
    return handle;
  }

  acceptEditSession(result: ItemEditSessionResult, item?: SnapshotItem): void {
    if (result.clientSessionId !== this.clientSessionId) return;
    const edit = this.editsById.get(result.editSessionId);
    if (!edit || edit.entityId !== result.entityId) return;
    if (item) this.remember(item);

    switch (result.status) {
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_ACTIVE:
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_RENEWED:
        edit.state = "active";
        edit.itemRevision = result.itemRevision;
        this.scheduleLeaseRenewal(edit, result.leaseExpiresAtUnixMs);
        if (edit.pendingPreview) {
          const preview = edit.pendingPreview;
          edit.pendingPreview = undefined;
          this.queuePreview(edit, preview);
        }
        break;
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_REJECTED:
        this.finishEdit(edit, "rejected", rejectCode(result.rejectCode), result.message);
        break;
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_EXPIRED:
        this.finishEdit(edit, "expired", "edit_expired", result.message);
        break;
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_SUPERSEDED:
        this.finishEdit(edit, "superseded", undefined, result.message);
        break;
      case ItemEditSessionStatus.ITEM_EDIT_SESSION_ENDED:
        this.finishEdit(edit, "ended", undefined, result.message);
        break;
    }
  }

  acceptPreview(preview: ItemEditPreview): void {
    if (!this.context().isHost) return;
    this.simulate({
      type: "moveItem",
      entityId: preview.entityId,
      transform: {
        x: preview.position?.x ?? 0,
        y: preview.position?.y ?? 0,
        rotation: preview.rotation,
        scale: preview.scale || 1,
        z: preview.z || undefined,
      },
      preview: true,
    });
  }

  acceptMutation(result: ItemMutationResult, item?: SnapshotItem): void {
    const authoritativeItem = freezeItem(item);
    if (result.accepted) {
      if (result.deletedEntityId) this.metadataById.delete(result.deletedEntityId);
      else if (authoritativeItem) this.remember(authoritativeItem);
      this.applyAccepted(result, authoritativeItem);
    } else if (authoritativeItem) {
      this.remember(authoritativeItem);
    }

    if (result.clientSessionId !== this.clientSessionId) return;
    const pending = this.pendingById.get(result.mutationId);
    if (!pending) return;
    if (result.accepted) {
      this.settleMutation(pending, Object.freeze({
        status: "accepted",
        mutationId: result.mutationId,
        sceneRevision: result.sceneRevision,
        itemRevision: result.itemRevision,
        item: authoritativeItem,
        deletedEntityId: result.deletedEntityId || undefined,
      }));
    } else {
      this.settleMutation(pending, Object.freeze({
        status: "rejected",
        mutationId: result.mutationId,
        code: rejectCode(result.rejectCode),
        message: result.message || undefined,
        authoritativeItem,
      }));
    }
  }

  private remember(item: SnapshotItem): void {
    this.metadataById.set(item.entityId, freezeItem(item)!);
  }

  private enqueue(
    request: ItemMutationRequest,
    editSessionId?: string,
    options?: ItemMutationOptions,
  ): ItemMutationReceipt {
    const mutationId = ++this.mutationCounter;
    let resolve!: (outcome: ItemMutationOutcome) => void;
    const settled = new Promise<ItemMutationOutcome>((complete) => { resolve = complete; });
    const receipt = Object.freeze({
      clientSessionId: this.clientSessionId,
      mutationId,
      editSessionId,
      settled,
    });
    const entityId = entityIdOf(request);
    if (request.kind !== "spawn" && !this.metadataById.has(request.entityId)) {
      const pending: PendingMutation = {
        mutationId,
        request,
        editSessionId,
        options,
        queueKey: request.entityId,
        receipt,
        resolve,
        sent: false,
      };
      this.pendingById.set(mutationId, pending);
      this.settleMutation(pending, Object.freeze({
        status: "rejected",
        mutationId,
        code: "not_found",
        message: "item is not in the canonical snapshot",
      }));
      return receipt;
    }
    if (request.kind === "spawn") {
      const definition = this.definitions.find(
        (candidate) => candidate.definitionId === request.definitionId,
      );
      if (!definition || !this.context().canvas) {
        const pending: PendingMutation = {
          mutationId,
          request,
          editSessionId,
          options,
          queueKey: `spawn-${mutationId}`,
          receipt,
          resolve,
          sent: false,
        };
        this.pendingById.set(mutationId, pending);
        this.settleMutation(pending, Object.freeze({
          status: "rejected",
          mutationId,
          code: "definition",
          message: "item definition or canvas is unavailable",
        }));
        return receipt;
      }
    }

    const queueKey = entityId ?? `spawn-${mutationId}`;
    const pending: PendingMutation = {
      mutationId,
      request,
      editSessionId,
      options,
      queueKey,
      receipt,
      resolve,
      sent: false,
    };
    this.pendingById.set(mutationId, pending);
    const queue = this.mutationQueues.get(queueKey) ?? [];
    queue.push(pending);
    this.mutationQueues.set(queueKey, queue);
    if (queue.length === 1) this.sendPending(pending);
    this.publishMutations();
    return receipt;
  }

  private localRejection(
    request: ItemMutationRequest,
    editSessionId: string | undefined,
    code: ItemMutationRejectCode,
    message: string,
  ): ItemMutationReceipt {
    const mutationId = ++this.mutationCounter;
    const outcome = Object.freeze({ status: "rejected" as const, mutationId, code, message });
    const receipt = Object.freeze({
      clientSessionId: this.clientSessionId,
      mutationId,
      editSessionId,
      settled: Promise.resolve(outcome),
    });
    this.lastOutcome = outcome;
    this.publishMutations();
    void request;
    return receipt;
  }

  private sendPending(pending: PendingMutation): void {
    if (!this.connectionReadyValue) return;
    const mutation = this.buildMutation(pending);
    pending.mutation = mutation;
    pending.sent = true;
    this.emit(Object.freeze({ type: "sendMutation", mutation }));
    this.publishMutations();
  }

  private buildMutation(pending: PendingMutation): ItemMutation {
    const request = pending.request;
    const entityId = entityIdOf(request) ?? "";
    const item = entityId ? this.metadataById.get(entityId) : undefined;
    const mutation: ItemMutation = {
      clientSessionId: this.clientSessionId,
      mutationId: pending.mutationId,
      editSessionId: pending.editSessionId ?? "",
      expectedItemRevision: item?.itemRevision ?? 0,
      kind: ItemMutationKind.ITEM_MUTATION_UNSPECIFIED,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: undefined,
      rotation: 0,
      z: 0,
      scale: 0,
      configJson: new Uint8Array(),
      isolated: false,
      collisionsEnabled: false,
      authorizationEvidence: pending.options?.authorizationEvidence
        ? new Uint8Array(pending.options.authorizationEvidence)
        : new Uint8Array(),
      applicationCorrelationId: pending.options?.applicationCorrelationId ?? "",
    };
    switch (request.kind) {
      case "spawn": {
        const definition = this.definitions.find(
          (candidate) => candidate.definitionId === request.definitionId,
        )!;
        const canvas = this.context().canvas!;
        const config = resolveItemConfig(
          definition as ItemDefinition<Record<string, unknown>>,
          { width: canvas.size.width, height: canvas.size.height, orientation: canvas.orientation },
        );
        mutation.kind = ItemMutationKind.ITEM_MUTATION_SPAWN;
        mutation.definitionId = request.definitionId;
        mutation.definitionVersion = definition.version;
        mutation.position = { x: request.transform.x, y: request.transform.y };
        mutation.rotation = request.transform.rotation;
        mutation.scale = request.transform.scale ?? 1;
        mutation.z = request.transform.z ?? 0;
        mutation.configJson = toJsonBytes(config);
        break;
      }
      case "transform":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_TRANSFORM;
        mutation.position = { x: request.transform.x, y: request.transform.y };
        mutation.rotation = request.transform.rotation;
        mutation.scale = request.transform.scale ?? 1;
        mutation.z = request.transform.z ?? 0;
        break;
      case "rotation":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_ROTATION;
        mutation.rotation = request.rotation;
        break;
      case "scale":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_SCALE;
        mutation.scale = request.scale;
        break;
      case "config":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_CONFIG;
        mutation.configJson = toJsonBytes(request.config);
        break;
      case "isolation":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_ISOLATION;
        mutation.isolated = request.isolated;
        break;
      case "collisions":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_COLLISIONS;
        mutation.collisionsEnabled = request.enabled;
        break;
      case "delete":
        mutation.kind = ItemMutationKind.ITEM_MUTATION_DELETE;
        break;
    }
    return Object.freeze(mutation);
  }

  private settleMutation(pending: PendingMutation, outcome: ItemMutationOutcome): void {
    if (!this.pendingById.delete(pending.mutationId)) return;
    const queue = this.mutationQueues.get(pending.queueKey);
    if (queue) {
      const index = queue.indexOf(pending);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.mutationQueues.delete(pending.queueKey);
      else if (index === 0) this.sendPending(queue[0]!);
    }
    this.lastOutcome = outcome;
    pending.resolve(outcome);
    this.publishMutations();
  }

  private previewEdit(edit: EditRecord, transform: Transform): void {
    if (edit.state === "ended" || edit.state === "ending") return;
    this.presentation.preview(edit.editSessionId, edit.entityId, transform);
    if (edit.state === "opening") {
      edit.pendingPreview = { ...transform };
      return;
    }
    this.queuePreview(edit, transform);
  }

  private queuePreview(edit: EditRecord, transform: Transform): void {
    const now = this.clock.now();
    const remaining = this.previewIntervalMs - (now - edit.lastPreviewSentAt);
    if (remaining <= 0) {
      this.sendPreview(edit, transform);
      return;
    }
    edit.pendingPreview = { ...transform };
    if (edit.previewTimer !== undefined) return;
    edit.previewTimer = this.clock.setTimeout(() => {
      edit.previewTimer = undefined;
      const pending = edit.pendingPreview;
      edit.pendingPreview = undefined;
      if (!pending || edit.state !== "active") return;
      this.sendPreview(edit, pending);
    }, remaining);
  }

  private sendPreview(edit: EditRecord, transform: Transform): void {
    edit.lastPreviewSentAt = this.clock.now();
    this.emit(Object.freeze({
      type: "sendPreview",
      preview: Object.freeze({
        clientSessionId: this.clientSessionId,
        editSessionId: edit.editSessionId,
        entityId: edit.entityId,
        previewSequence: ++edit.previewSequence,
        position: { x: transform.x, y: transform.y },
        rotation: transform.rotation,
        z: transform.z ?? 0,
        scale: transform.scale ?? 1,
        revert: false,
      }),
    }));
  }

  private requestEditEnd(edit: EditRecord, cancel: boolean): void {
    if (edit.state === "ending" || edit.state === "ended") return;
    edit.state = "ending";
    this.clearEditTimers(edit);
    this.emit(Object.freeze({
      type: "endEdit",
      request: Object.freeze({
        clientSessionId: this.clientSessionId,
        editSessionId: edit.editSessionId,
        entityId: edit.entityId,
        cancel,
      }),
    }));
  }

  private clearPendingPreview(edit: EditRecord): void {
    if (edit.previewTimer !== undefined) this.clock.clearTimeout(edit.previewTimer);
    edit.previewTimer = undefined;
    edit.pendingPreview = undefined;
  }

  private scheduleLeaseRenewal(edit: EditRecord, expiresAtMs: number): void {
    if (edit.leaseTimer !== undefined) this.clock.clearTimeout(edit.leaseTimer);
    const delay = Math.max(1, (expiresAtMs - this.clock.now()) / 2);
    edit.leaseTimer = this.clock.setTimeout(() => {
      edit.leaseTimer = undefined;
      if (edit.state !== "active") return;
      this.emit(Object.freeze({
        type: "renewEdit",
        request: Object.freeze({
          clientSessionId: this.clientSessionId,
          editSessionId: edit.editSessionId,
          entityId: edit.entityId,
        }),
      }));
    }, delay);
  }

  private finishEdit(
    edit: EditRecord,
    status: ItemEditEndOutcome["status"],
    code?: ItemMutationRejectCode,
    message?: string,
  ): void {
    if (edit.state === "ended") return;
    edit.state = "ended";
    this.clearEditTimers(edit);
    this.presentation.endEdit(edit.editSessionId);
    this.editsById.delete(edit.editSessionId);
    if (this.editByEntity.get(edit.entityId) === edit) this.editByEntity.delete(edit.entityId);
    edit.resolveEnded(Object.freeze({
      status,
      editSessionId: edit.editSessionId,
      entityId: edit.entityId,
      code,
      message: message || undefined,
    }));
  }

  private clearEditTimers(edit: EditRecord): void {
    if (edit.leaseTimer !== undefined) this.clock.clearTimeout(edit.leaseTimer);
    if (edit.previewTimer !== undefined) this.clock.clearTimeout(edit.previewTimer);
    edit.leaseTimer = undefined;
    edit.previewTimer = undefined;
    edit.pendingPreview = undefined;
  }

  private simulate(request: SimulationRequest): void {
    this.emit(Object.freeze({ type: "simulate", request }));
  }

  private applyAccepted(result: ItemMutationResult, item?: SnapshotItem): void {
    if (!this.context().isHost) return;
    switch (result.kind) {
      case ItemMutationKind.ITEM_MUTATION_SPAWN:
        if (!item) return;
        this.simulate({
          type: "addItem",
          instance: {
            entityId: item.entityId,
            canvasId: this.context().canvas?.id ?? "",
            definitionId: item.definitionId,
            definitionVersion: item.definitionVersion,
            ownerUserId: item.ownerUserId,
            itemRevision: item.itemRevision,
            transform: item.transform,
            resolvedConfig: item.resolvedConfig,
            behaviorState: item.behaviorState,
            behaviorStateVersion: item.behaviorStateVersion,
            createdAt: new Date().toISOString(),
            sceneRevision: result.sceneRevision,
            isolated: item.isolated,
            collisionsDisabled: item.collisionsDisabled,
          },
        });
        return;
      case ItemMutationKind.ITEM_MUTATION_DELETE:
        this.simulate({ type: "removeItem", entityId: result.deletedEntityId || result.entityId });
        return;
      case ItemMutationKind.ITEM_MUTATION_TRANSFORM:
      case ItemMutationKind.ITEM_MUTATION_ROTATION:
      case ItemMutationKind.ITEM_MUTATION_SCALE:
        if (item) {
          this.simulate({
            type: "moveItem",
            entityId: item.entityId,
            transform: item.transform,
            preview: false,
          });
        }
        break;
      case ItemMutationKind.ITEM_MUTATION_CONFIG:
        if (item) this.simulate({ type: "setItemConfig", entityId: item.entityId, config: item.resolvedConfig });
        break;
      case ItemMutationKind.ITEM_MUTATION_ISOLATION:
        if (item) this.simulate({ type: "setItemIsolation", entityId: item.entityId, isolated: item.isolated === true });
        break;
      case ItemMutationKind.ITEM_MUTATION_COLLISIONS:
        if (item) this.simulate({ type: "setItemCollisions", entityId: item.entityId, enabled: item.collisionsDisabled !== true });
        break;
    }
    if (item) {
      this.simulate({
        type: "setItemRevision",
        entityId: item.entityId,
        itemRevision: item.itemRevision,
      });
    }
  }

  private mutationSnapshot(): ItemMutationSnapshot {
    return Object.freeze({
      pending: Object.freeze([...this.pendingById.values()].map((pending) => Object.freeze({
        mutationId: pending.mutationId,
        editSessionId: pending.editSessionId,
        entityId: entityIdOf(pending.request),
        kind: pending.request.kind,
        sent: pending.sent,
      }))),
      lastOutcome: this.lastOutcome,
    });
  }

  private publishMutations(): void {
    const snapshot = this.mutationSnapshot();
    this.mutationObservers.publish(snapshot);
  }
}

const rejectCode = (code: WireRejectCode): ItemMutationRejectCode => {
  switch (code) {
    case WireRejectCode.ITEM_MUTATION_REJECT_NOT_FOUND: return "not_found";
    case WireRejectCode.ITEM_MUTATION_REJECT_SYSTEM_OWNED: return "system_owned";
    case WireRejectCode.ITEM_MUTATION_REJECT_NOT_OWNER: return "not_owner";
    case WireRejectCode.ITEM_MUTATION_REJECT_EDIT_IN_USE: return "edit_in_use";
    case WireRejectCode.ITEM_MUTATION_REJECT_EDIT_EXPIRED: return "edit_expired";
    case WireRejectCode.ITEM_MUTATION_REJECT_STALE_ITEM_REVISION: return "stale_item_revision";
    case WireRejectCode.ITEM_MUTATION_REJECT_OUTSIDE_CANVAS: return "outside_canvas";
    case WireRejectCode.ITEM_MUTATION_REJECT_SCALE_OUT_OF_RANGE: return "scale_out_of_range";
    case WireRejectCode.ITEM_MUTATION_REJECT_DEFINITION: return "definition";
    case WireRejectCode.ITEM_MUTATION_REJECT_CONFIG: return "config";
    case WireRejectCode.ITEM_MUTATION_REJECT_CAPACITY: return "capacity";
    case WireRejectCode.ITEM_MUTATION_REJECT_RECEIPT_EXPIRED: return "receipt_expired";
    case WireRejectCode.ITEM_MUTATION_REJECT_INTERNAL: return "internal";
    case WireRejectCode.ITEM_MUTATION_REJECT_APPLICATION_POLICY: return "application_policy";
    case WireRejectCode.ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE: return "application_unavailable";
    case WireRejectCode.ITEM_MUTATION_REJECT_APPLICATION_CORRELATION_CONFLICT:
      return "application_correlation_conflict";
    default: return "malformed";
  }
};
