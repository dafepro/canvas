import type {
  CanvasDefinition,
  ItemDefinition,
  Transform,
  Vec2,
} from "@canvas-physics/core";
import type { RoomTransport } from "../net/transport.js";
import type { RealtimeCredentialProvider } from "../net/websocket-transport.js";
import { PixiScene, type SceneOptions } from "../render/pixi-scene.js";
import { FrameProfiler } from "../render/frame-profiler.js";
import { KeyboardController } from "../input/keyboard-controller.js";
import {
  FullscreenController,
  type FullscreenObserver,
} from "../input/fullscreen-controller.js";
import {
  AvatarPointerInteraction,
  type AvatarPointerOptions,
} from "../input/avatar-pointer-interaction.js";
import {
  PointerInteractionCoordinator,
  type PointerInteractionDiagnostics,
  type PointerInteractionStrategy,
} from "../input/pointer-interaction-coordinator.js";
import {
  ItemEditInteraction,
  findOwnedItemAt,
  type ItemEditState,
} from "../input/item-edit-interaction.js";
import type { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity } from "../simulation/messages.js";
import {
  RoomSession,
  type InputIntent,
  type ParticipantAvatarProjector,
  type RoomSessionRates,
  type SessionDiagnostics,
} from "./room-session.js";
import type {
  ItemEditHandle,
  ItemMutationReceipt,
  ItemMutationSnapshot,
} from "./session/item-mutation-session.js";
import {
  pixiAssetLoader,
  preloadAssetManifest,
  validateAssetReferences,
  type AssetManifest,
  type AssetLoaderAdapter,
  type AssetWarning,
  type LoadedAssetBundle,
} from "../assets/index.js";
import type { Texture } from "pixi.js";
import {
  CanvasConsumerError,
  lifecycleError,
  type CanvasLifecycleState,
} from "./lifecycle.js";
import {
  RuntimeStartupProgressCoordinator,
  type RuntimeStartupObserver,
  type RuntimeStartupSnapshot,
} from "./startup-progress.js";
import {
  OverlayProjectionStore,
  cssPointToRenderer,
  cssOverlayViewport,
  projectOverlayPoint,
  type OverlayPointProjection,
  type OverlayProjectionObserver,
  type OverlayProjectionOptions,
  type OverlayViewportProjection,
} from "../render/overlay-projection.js";

export interface CanvasRuntimeOptions {
  /** Product-owned room instance id. The server resolves its canvas template. */
  roomId: string;
  serverUrl: string;
  /** Required when transport is omitted. Called for every WebSocket attempt. */
  credentialProvider?: RealtimeCredentialProvider;
  mount: HTMLElement;
  /** Element promoted to fullscreen. Defaults to the renderer mount. */
  fullscreenElement?: HTMLElement;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  driver?: SimulationDriver;
  /** Rates from spec 10.3. */
  rates?: RoomSessionRates;
  scene?: SceneOptions;
  /** Pointer/touch movement style. Defaults to a relative thumbstick. */
  pointer?: Omit<AvatarPointerOptions, "avatarPosition">;
  /** Product-local exclusive gestures. Higher priority claims pointer-down first. */
  pointerInteractions?: readonly PointerInteractionStrategy[];
  /** Named room spawn used for this session, such as a linked-room arrival. */
  spawnPointId?: string;
  /** Consumer-owned art. Required sources preload before the room connection opens. */
  assets?: AssetManifest;
  /** Advanced override for tests or a consumer-specific texture loader. */
  assetLoader?: AssetLoaderAdapter<Texture>;
  onAssetWarning?: (warning: Readonly<AssetWarning>) => void;
  /** Typed runtime, transport, protocol, simulation, and asset failures. */
  onError?: (error: CanvasConsumerError) => void;
  /** Diagnostics callback frequency. Defaults to 4 Hz to stay off the render hot path. */
  diagnosticsHz?: number;
  onDiagnostics?: (diagnostics: RuntimeDiagnostics) => void;
  /** Addendum A1. Runs after the local avatar changes its disabled state. */
  onAvatarDisabledChange?: (disabled: boolean) => void;
  /** Presentation policy for rooms where disabled avatars must fully leave view. */
  hideDisabledAvatars?: boolean;
  onEditModeChange?: (enabled: boolean) => void;
  onEditSelectionChange?: (state: ItemEditState) => void;
  /** Product-owned placement for inactive or disconnected participants. */
  projectParticipantAvatar?: ParticipantAvatarProjector;
}

export interface RuntimeDiagnostics extends SessionDiagnostics {
  renderFps: number;
  renderP95Ms: number;
  renderWorstMs: number;
  renderLongFrames: number;
  backgroundResumes: number;
  lastBackgroundMs: number;
  pointer?: Readonly<PointerInteractionDiagnostics>;
  pointerWorldTarget?: Readonly<Vec2>;
}

export const runtimeDiagnosticsIntervalMs = (requestedHz = 4): number => {
  const hz = Number.isFinite(requestedHz) && requestedHz > 0
    ? Math.min(requestedHz, 60)
    : 4;
  return 1_000 / hz;
};

/**
 * The façade an application uses. It adds the renderer and the input
 * controllers to one `RoomSession`. Every network and simulation rule lives in
 * the session, so the same rules run in a test with no DOM.
 */
export class CanvasRuntime {
  readonly session: RoomSession;
  private scene?: PixiScene;
  private pointer?: AvatarPointerInteraction;
  private pointerCoordinator?: PointerInteractionCoordinator;
  private editor?: ItemEditInteraction;
  private keyboard?: KeyboardController;
  private renderFps = 0;
  private readonly frameProfiler = new FrameProfiler();
  private lastDiagnosticsAtMs = Number.NEGATIVE_INFINITY;
  private hiddenAtMs?: number;
  private backgroundResumes = 0;
  private lastBackgroundMs = 0;
  private skipNextFrameProfile = false;
  private running = false;
  private visibilityListener?: () => void;
  private pageHideListener?: () => void;
  private avatarDisabled = false;
  private localAvatarPresentationHidden = false;
  private editMode = false;
  private activeItemEdit?: ItemEditHandle;
  private latestEntities: RenderEntity[] = [];
  private disableKeyListener?: (event: KeyboardEvent) => void;
  private assetBundle?: LoadedAssetBundle<Texture>;
  private startPromise?: Promise<void>;
  private readonly overlayProjections = new OverlayProjectionStore();
  private readonly fullscreen?: FullscreenController;
  private pointerWorldTarget?: Vec2;
  private readonly startup = new RuntimeStartupProgressCoordinator();

  constructor(private readonly options: CanvasRuntimeOptions) {
    this.startup.configureAssets(options.assets?.sources ?? []);
    if (typeof document !== "undefined") {
      this.fullscreen = new FullscreenController(
        options.fullscreenElement ?? options.mount,
      );
    }
    this.session = new RoomSession({
      roomId: options.roomId,
      serverUrl: options.serverUrl,
      credentialProvider: options.credentialProvider,
      definitions: options.definitions,
      transport: options.transport,
      driver: options.driver,
      rates: options.rates,
      intent: () => this.mergedIntent(),
      spawnPointId: options.spawnPointId,
      projectParticipantAvatar: options.projectParticipantAvatar,
      onJoined: (canvas) => this.mountScene(canvas),
      onError: options.onError,
    });
    this.session.subscribeStartup((snapshot) => this.startup.acceptSession(snapshot));
    this.session.subscribeEffects((emission) => this.scene?.effects.apply(emission));
  }

  /** The coordination client, for an application that needs the raw events. */
  get client() {
    return this.session.client;
  }

  subscribePresence(...args: Parameters<RoomSession["subscribePresence"]>) {
    return this.session.subscribePresence(...args);
  }

  subscribeCanonicalState(...args: Parameters<RoomSession["subscribeCanonicalState"]>) {
    return this.session.subscribeCanonicalState(...args);
  }

  subscribeBehaviorState(...args: Parameters<RoomSession["subscribeBehaviorState"]>) {
    return this.session.subscribeBehaviorState(...args);
  }

  /** Presentation-only departure affordance; canonical simulation continues. */
  setLocalAvatarPresentationHidden(hidden: boolean): void {
    this.localAvatarPresentationHidden = hidden;
  }

  subscribeEffects(...args: Parameters<RoomSession["subscribeEffects"]>) {
    return this.session.subscribeEffects(...args);
  }

  subscribeParticipantSignals(
    ...args: Parameters<RoomSession["subscribeParticipantSignals"]>
  ) {
    return this.session.subscribeParticipantSignals(...args);
  }

  sendParticipantSignal(...args: Parameters<RoomSession["sendParticipantSignal"]>) {
    this.session.sendParticipantSignal(...args);
  }

  get isFullscreen(): boolean {
    return this.fullscreen?.active ?? false;
  }

  enterFullscreen(): Promise<boolean> {
    return this.fullscreen?.enter() ?? Promise.resolve(false);
  }

  exitFullscreen(): Promise<boolean> {
    return this.fullscreen?.exit() ?? Promise.resolve(false);
  }

  toggleFullscreen(): Promise<boolean> {
    return this.fullscreen?.toggle() ?? Promise.resolve(false);
  }

  subscribeFullscreen(observer: FullscreenObserver): () => void {
    return this.fullscreen?.subscribe(observer) ?? (() => {});
  }

  get lifecycleState(): CanvasLifecycleState {
    return this.session.lifecycleState;
  }

  subscribeLifecycle(...args: Parameters<RoomSession["subscribeLifecycle"]>) {
    return this.session.subscribeLifecycle(...args);
  }

  get startupSnapshot(): Readonly<RuntimeStartupSnapshot> {
    return this.startup.snapshot;
  }

  subscribeStartup(observer: RuntimeStartupObserver): () => void {
    return this.startup.subscribe(observer);
  }

  /** Resolves only after assets, canonical state, and the first Pixi update. */
  whenStartupReady(): Promise<void> {
    return this.startup.waitUntilReady();
  }

  /** Bounded plain-data samples for DOM labels, controls, and product overlays. */
  subscribeOverlayProjection(
    observer: OverlayProjectionObserver,
    options?: OverlayProjectionOptions,
  ): () => void {
    return this.overlayProjections.subscribe(observer, options);
  }

  /** Projects a product-owned world anchor, or returns undefined before mount. */
  projectWorldPoint(
    point: Readonly<{ x: number; y: number; z?: number }>,
  ): Readonly<OverlayPointProjection> | undefined {
    const viewport = this.overlayViewport();
    const canvas = this.session.canvas;
    if (!viewport || !canvas) return undefined;
    return projectOverlayPoint(point, canvas.size, viewport);
  }

  whenReady(): Promise<void> {
    return this.session.whenReady();
  }

  /** Waits for a complete authoritative frame before revealing a staged room. */
  whenPresented(): Promise<void> {
    return this.session.whenPresented();
  }

  start(): Promise<void> {
    if (this.session.lifecycleState === "failed" ||
        this.session.lifecycleState === "stopping" ||
        this.session.lifecycleState === "stopped") {
      return this.session.start();
    }
    if (this.startPromise) return this.startPromise;
    this.running = true;
    const operation = (async () => {
      try {
        if (this.options.assets) {
          this.assetBundle = await preloadAssetManifest(this.options.assets, {
            adapter: this.options.assetLoader ?? pixiAssetLoader,
            onProgress: (progress) => this.startup.updateAssets(progress),
            onWarning: this.options.onAssetWarning,
          });
        }
        if (!this.running) {
          throw lifecycleError(
            "start_cancelled",
            "Runtime startup was cancelled by stop",
          );
        }
        this.startup.completeAssets();
        await this.session.start();
      } catch (cause) {
        this.running = false;
        if (cause instanceof CanvasConsumerError) throw cause;
        const error = lifecycleError(
          "asset_preload_failed",
          cause instanceof Error ? cause.message : "Required assets failed to preload",
          { source: "assets", cause },
        );
        this.startup.fail(error);
        this.session.stop();
        try {
          this.options.onError?.(error);
        } catch {
          // Keep the typed start rejection stable even if consumer reporting fails.
        }
        throw error;
      }
    })();
    this.startPromise = operation;
    return operation;
  }

  stop(): void {
    this.prepareStop();
    this.session.stop();
    this.destroyScene();
  }

  async stopGracefully(timeoutMs = 250): Promise<void> {
    this.prepareStop();
    await this.session.stopGracefully(timeoutMs);
    this.destroyScene();
  }

  private prepareStop(): void {
    this.running = false;
    this.startup.cancel();
    if (this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = undefined;
    }
    if (this.pageHideListener) {
      window.removeEventListener("pagehide", this.pageHideListener);
      this.pageHideListener = undefined;
    }
    if (this.disableKeyListener) {
      window.removeEventListener("keydown", this.disableKeyListener);
      this.disableKeyListener = undefined;
    }
    this.pointerCoordinator?.destroy();
    this.pointerCoordinator = undefined;
    this.pointer?.reset();
    this.pointer = undefined;
    this.editor?.clear();
    this.editor = undefined;
    this.keyboard?.destroy();
    this.keyboard = undefined;
    this.overlayProjections.clear();
    if (this.fullscreen?.active) void this.fullscreen.exit();
    this.fullscreen?.destroy();
  }

  private destroyScene(): void {
    const scene = this.scene;
    this.scene = undefined;
    scene?.destroy();
  }

  private async mountScene(canvas: CanvasDefinition): Promise<void> {
    if (this.options.assets) {
      for (const message of validateAssetReferences(
        this.options.assets,
        canvas,
        this.options.definitions,
      )) {
        this.options.onAssetWarning?.(Object.freeze({
          sourceId: "references",
          message,
          cause: undefined,
        }));
      }
    }
    this.scene = new PixiScene(
      canvas,
      this.options.definitions,
      this.options.scene,
      this.assetBundle,
    );
    await this.scene.mount(this.options.mount);
    this.pointer = new AvatarPointerInteraction({
      ...this.options.pointer,
      avatarPosition: () => {
        const avatar = this.latestEntities.find(
          (entity) => entity.kind === "avatar" && entity.userId === this.session.userId,
        );
        if (!avatar) return undefined;
        return this.projectWorldPoint({ x: avatar.x, y: avatar.y })?.screen;
      },
    });
    this.editor = new ItemEditInteraction({
      enabled: () => this.editMode,
      pick: (point, preferredEntityId) =>
        findOwnedItemAt(
          this.latestEntities,
          this.options.definitions,
          this.pointerLocalToWorld(point),
          this.session.userId,
          preferredEntityId,
        ),
      onPreview: (entityId, transform) => {
        if (this.activeItemEdit?.entityId === entityId) {
          this.activeItemEdit.preview(transform);
        }
      },
      onCommit: (entityId, transform) => {
        if (this.activeItemEdit?.entityId === entityId) {
          this.activeItemEdit.mutate({ kind: "transform", entityId, transform });
        } else {
          this.moveItem(entityId, transform);
        }
      },
      onChange: (state) => {
        if (state.selectedEntityId !== this.activeItemEdit?.entityId) {
          this.activeItemEdit?.end();
          this.activeItemEdit = state.selectedEntityId
            ? this.session.beginItemEdit(state.selectedEntityId)
            : undefined;
        }
        this.scene?.setEditState(state);
        this.options.onEditSelectionChange?.(state);
      },
    });
    this.pointerCoordinator = new PointerInteractionCoordinator(
      this.scene.app.canvas as unknown as HTMLElement,
      {
        strategies: [
          ...(this.options.pointerInteractions ?? []),
          this.editor,
          this.pointer,
        ],
        toWorld: (point) => this.pointerLocalToWorld(point),
        onError: (cause, strategyId) => {
          const error = lifecycleError(
            "pointer_interaction_failed",
            `Pointer interaction '${strategyId}' failed`,
            {
              source: "input",
              recoverable: true,
              cause,
              details: { strategyId },
            },
          );
          try {
            this.options.onError?.(error);
          } catch {
            // Consumer reporting cannot corrupt pointer ownership.
          }
        },
      },
    );
    this.keyboard = new KeyboardController();
    this.startRenderLoop();
    this.watchVisibility();
    this.watchDisableKey();
  }

  /**
   * Addendum A1. A disabled avatar keeps its place, but no physics act on it.
   * The flag rides on every input, so the host always holds the newest value.
   */
  setAvatarDisabled(disabled: boolean): void {
    if (this.avatarDisabled === disabled) return;
    this.avatarDisabled = disabled;
    const coordinator = this.pointerCoordinator;
    const pointer = this.pointer;
    if (
      disabled &&
      coordinator &&
      pointer &&
      coordinator.diagnostics.strategyId === pointer.id
    ) {
      coordinator.cancel("avatar_disabled");
      pointer.reset();
    }
    this.options.onAvatarDisabledChange?.(disabled);
  }

  toggleAvatarDisabled(): boolean {
    this.setAvatarDisabled(!this.avatarDisabled);
    return this.avatarDisabled;
  }

  get isAvatarDisabled(): boolean {
    return this.avatarDisabled;
  }

  setEditMode(enabled: boolean): void {
    if (this.editMode === enabled) return;
    this.editMode = enabled;
    if (!enabled) {
      this.clearItemEditSelection();
    }
    if (this.scene) this.scene.app.canvas.style.cursor = enabled ? "crosshair" : "";
    this.options.onEditModeChange?.(enabled);
  }

  toggleEditMode(): boolean {
    this.setEditMode(!this.editMode);
    return this.editMode;
  }

  get isEditMode(): boolean {
    return this.editMode;
  }

  /** Clears private selection/presentation without disabling live editing. */
  clearItemEditSelection(): void {
    const coordinator = this.pointerCoordinator;
    const editor = this.editor;
    if (coordinator && editor && coordinator.diagnostics.strategyId === editor.id) {
      coordinator.cancel("selection_changed");
    }
    this.editor?.clear();
  }

  /** Selects an owned item through product UI using the same state as pointer editing. */
  selectItemForEdit(entityId: string): boolean {
    if (!this.editMode || !this.editor) return false;
    const entity = this.latestEntities.find(
      (candidate) =>
        candidate.id === entityId &&
        candidate.kind === "item" &&
        candidate.ownerUserId === this.session.userId &&
        candidate.respawning !== true,
    );
    if (!entity) return false;
    this.pointerCoordinator?.cancel("selection_changed");
    this.editor.select(entity);
    return true;
  }

  private mergedIntent(): InputIntent {
    if (this.avatarDisabled) {
      this.pointerWorldTarget = undefined;
      return { direction: { x: 0, y: 0 }, intensity: 0, held: false, disabled: true };
    }
    const pointer = this.pointer?.intent;
    if (pointer?.target && this.scene) {
      const canvas = this.scene.app.canvas;
      const rect = canvas.getBoundingClientRect();
      const target = cssPointToRenderer(
        pointer.target,
        {
          width: this.scene.app.renderer.width,
          height: this.scene.app.renderer.height,
        },
        { width: rect.width, height: rect.height },
      );
      const worldTarget = this.scene.camera.toWorld(target.x, target.y);
      this.pointerWorldTarget = { ...worldTarget };
      return {
        ...pointer,
        target: worldTarget,
      };
    }
    this.pointerWorldTarget = undefined;
    if (pointer && pointer.intensity > 0) return pointer;
    const keyboard = this.keyboard?.intent;
    if (keyboard && keyboard.intensity > 0) return keyboard;
    return { direction: { x: 0, y: 0 }, intensity: 0, held: false };
  }

  private pointerLocalToWorld(point: Readonly<Vec2>): Vec2 {
    const scene = this.scene;
    if (!scene) return { ...point };
    const rect = scene.app.canvas.getBoundingClientRect();
    const rendererPoint = cssPointToRenderer(
      point,
      {
        width: scene.app.renderer.width,
        height: scene.app.renderer.height,
      },
      { width: rect.width, height: rect.height },
    );
    return scene.camera.toWorld(rendererPoint.x, rendererPoint.y);
  }

  private startRenderLoop(): void {
    const scene = this.scene;
    if (!scene) return;
    scene.app.ticker.add(() => {
      if (!this.running) return;
      const nowMs = performance.now();
      const deltaMs = scene.frameDelta(nowMs);
      this.renderFps = deltaMs > 0 ? 1000 / deltaMs : 0;
      if (this.skipNextFrameProfile) {
        this.skipNextFrameProfile = false;
      } else {
        this.frameProfiler.sample(deltaMs);
      }
      let entities = this.session.entitiesToDraw(nowMs);
      if (this.localAvatarPresentationHidden || this.options.hideDisabledAvatars) {
        entities = entities.filter((entity) => {
          if (this.localAvatarPresentationHidden && entity.id === this.session.avatarId) {
            return false;
          }
          return !(this.options.hideDisabledAvatars && entity.kind === "avatar" && entity.disabled);
        });
      }
      this.latestEntities = entities;
      scene.update(entities, deltaMs);
      this.startup.markPresentedFrame();
      if (this.overlayProjections.hasObservers && this.session.canvas) {
        this.overlayProjections.publish({
          sampledAtMs: nowMs,
          tick: this.session.tick,
          canvasSize: this.session.canvas.size,
          viewport: this.overlayViewport()!,
          entities,
        });
      }
      scene.setThumbstick(this.pointer?.gesture);
      if (
        this.options.onDiagnostics &&
        nowMs - this.lastDiagnosticsAtMs >= runtimeDiagnosticsIntervalMs(
          this.options.diagnosticsHz,
        )
      ) {
        this.lastDiagnosticsAtMs = nowMs;
        this.options.onDiagnostics(this.diagnostics());
      }
    });
  }

  /** Addendum A1. The `P` key disables and enables the local avatar. */
  private watchDisableKey(): void {
    this.disableKeyListener = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "p") return;
      this.toggleAvatarDisabled();
    };
    window.addEventListener("keydown", this.disableKeyListener);
  }

  private watchVisibility(): void {
    const applyVisibility = () => {
      const nowMs = performance.now();
      const visible = document.visibilityState === "visible";
      if (!visible && this.hiddenAtMs === undefined) {
        this.hiddenAtMs = nowMs;
      } else if (visible && this.hiddenAtMs !== undefined) {
        this.lastBackgroundMs = nowMs - this.hiddenAtMs;
        this.backgroundResumes += 1;
        this.hiddenAtMs = undefined;
        // A suspended tab produces one huge ticker delta on resume. Record the
        // suspension separately instead of corrupting the render percentile.
        this.frameProfiler.reset();
        this.skipNextFrameProfile = true;
      }
      this.session.setPageVisible(visible);
    };
    this.visibilityListener = applyVisibility;
    document.addEventListener("visibilitychange", this.visibilityListener);
    applyVisibility();
    this.pageHideListener = () => {
      void this.stopGracefully(150);
    };
    window.addEventListener("pagehide", this.pageHideListener);
  }

  private overlayViewport(): Readonly<OverlayViewportProjection> | undefined {
    const scene = this.scene;
    if (!scene) return undefined;
    const viewport = Object.freeze({
      width: scene.app.renderer.width,
      height: scene.app.renderer.height,
      scale: scene.camera.scale,
      offsetX: scene.camera.offsetX,
      offsetY: scene.camera.offsetY,
    });
    const rect = scene.app.canvas.getBoundingClientRect();
    return cssOverlayViewport(viewport, { width: rect.width, height: rect.height });
  }

  // ---------- durable mutations ----------

  spawnItem(definitionId: string, at: Vec2, rotation = 0, scale = 1): ItemMutationReceipt {
    return this.session.spawnItem(definitionId, at, rotation, scale);
  }

  moveItem(entityId: string, transform: Transform) {
    return this.session.moveItem(entityId, transform);
  }

  rotateItem(entityId: string, rotation: number): ItemMutationReceipt {
    return this.session.rotateItem(entityId, rotation);
  }

  scaleItem(entityId: string, scale: number): ItemMutationReceipt {
    return this.session.scaleItem(entityId, scale);
  }

  setItemConfig(entityId: string, config: unknown): ItemMutationReceipt {
    return this.session.setItemConfig(entityId, config);
  }

  setItemIsolation(entityId: string, isolated: boolean): ItemMutationReceipt {
    return this.session.setItemIsolation(entityId, isolated);
  }

  setItemCollisionsEnabled(entityId: string, enabled: boolean): ItemMutationReceipt {
    return this.session.setItemCollisionsEnabled(entityId, enabled);
  }

  deleteItem(entityId: string): ItemMutationReceipt {
    return this.session.deleteItem(entityId);
  }

  subscribeItemMutations(observer: (snapshot: ItemMutationSnapshot) => void): () => void {
    return this.session.subscribeItemMutations(observer);
  }

  diagnostics(): RuntimeDiagnostics {
    const frames = this.frameProfiler.diagnostics();
    return {
      ...this.session.diagnostics(),
      renderFps: this.renderFps,
      renderP95Ms: frames.p95Ms,
      renderWorstMs: frames.worstMs,
      renderLongFrames: frames.longFrames,
      backgroundResumes: this.backgroundResumes,
      lastBackgroundMs: this.lastBackgroundMs,
      pointer: this.pointerCoordinator?.diagnostics,
      pointerWorldTarget: this.pointerWorldTarget
        ? Object.freeze({ ...this.pointerWorldTarget })
        : undefined,
    };
  }
}
