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
import { PointerDragController } from "../input/pointer-drag-controller.js";
import {
  ItemEditController,
  findOwnedItemAt,
  type ItemEditState,
} from "../input/item-edit-controller.js";
import type { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity } from "../simulation/messages.js";
import {
  RoomSession,
  type InputIntent,
  type ParticipantAvatarProjector,
  type RoomSessionRates,
  type SessionDiagnostics,
} from "./room-session.js";
import {
  pixiAssetLoader,
  preloadAssetManifest,
  validateAssetReferences,
  type AssetManifest,
  type AssetLoaderAdapter,
  type AssetProgress,
  type AssetWarning,
  type LoadedAssetBundle,
} from "../assets/index.js";
import type { Texture } from "pixi.js";

export interface CanvasRuntimeOptions {
  canvasId: string;
  serverUrl: string;
  /** Required when transport is omitted. Called for every WebSocket attempt. */
  credentialProvider?: RealtimeCredentialProvider;
  mount: HTMLElement;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  driver?: SimulationDriver;
  /** Rates from spec 10.3. */
  rates?: RoomSessionRates;
  scene?: SceneOptions;
  /** Consumer-owned art. Required sources preload before the room connection opens. */
  assets?: AssetManifest;
  /** Advanced override for tests or a consumer-specific texture loader. */
  assetLoader?: AssetLoaderAdapter<Texture>;
  onAssetProgress?: (progress: Readonly<AssetProgress>) => void;
  onAssetWarning?: (warning: Readonly<AssetWarning>) => void;
  onDiagnostics?: (diagnostics: RuntimeDiagnostics) => void;
  /** Addendum A1. Runs after the local avatar changes its disabled state. */
  onAvatarDisabledChange?: (disabled: boolean) => void;
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
}

/**
 * The façade an application uses. It adds the renderer and the input
 * controllers to one `RoomSession`. Every network and simulation rule lives in
 * the session, so the same rules run in a test with no DOM.
 */
export class CanvasRuntime {
  readonly session: RoomSession;
  private scene?: PixiScene;
  private pointer?: PointerDragController;
  private editor?: ItemEditController;
  private keyboard?: KeyboardController;
  private renderFps = 0;
  private readonly frameProfiler = new FrameProfiler();
  private hiddenAtMs?: number;
  private backgroundResumes = 0;
  private lastBackgroundMs = 0;
  private skipNextFrameProfile = false;
  private running = false;
  private visibilityListener?: () => void;
  private pageHideListener?: () => void;
  private avatarDisabled = false;
  private editMode = false;
  private latestEntities: RenderEntity[] = [];
  private disableKeyListener?: (event: KeyboardEvent) => void;
  private assetBundle?: LoadedAssetBundle<Texture>;

  constructor(private readonly options: CanvasRuntimeOptions) {
    this.session = new RoomSession({
      canvasId: options.canvasId,
      serverUrl: options.serverUrl,
      credentialProvider: options.credentialProvider,
      definitions: options.definitions,
      transport: options.transport,
      driver: options.driver,
      rates: options.rates,
      intent: () => this.mergedIntent(),
      projectParticipantAvatar: options.projectParticipantAvatar,
      onJoined: (canvas) => this.mountScene(canvas),
    });
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

  subscribeEffects(...args: Parameters<RoomSession["subscribeEffects"]>) {
    return this.session.subscribeEffects(...args);
  }

  async start(): Promise<void> {
    this.running = true;
    try {
      if (this.options.assets) {
        this.assetBundle = await preloadAssetManifest(this.options.assets, {
          adapter: this.options.assetLoader ?? pixiAssetLoader,
          onProgress: this.options.onAssetProgress,
          onWarning: this.options.onAssetWarning,
        });
      }
      await this.session.start();
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  stop(): void {
    this.prepareStop();
    this.session.stop();
    this.scene?.destroy();
  }

  async stopGracefully(timeoutMs = 250): Promise<void> {
    this.prepareStop();
    await this.session.stopGracefully(timeoutMs);
    this.scene?.destroy();
  }

  private prepareStop(): void {
    this.running = false;
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
    this.pointer?.destroy();
    this.editor?.destroy();
    this.keyboard?.destroy();
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
    this.pointer = new PointerDragController(
      this.scene.app.canvas as unknown as HTMLElement,
    );
    this.editor = new ItemEditController(
      this.scene.app.canvas as unknown as HTMLElement,
      {
        enabled: () => this.editMode,
        pick: (point) =>
          findOwnedItemAt(
            this.latestEntities,
            this.options.definitions,
            this.scene!.camera.toWorld(point.x, point.y),
            this.session.userId,
          ),
        toWorld: (point) => this.scene!.camera.toWorld(point.x, point.y),
        onPreview: (entityId, transform) => this.moveItem(entityId, transform, true),
        onCommit: (entityId, transform) => this.moveItem(entityId, transform),
        onChange: (state) => {
          this.scene?.setEditState(state);
          this.options.onEditSelectionChange?.(state);
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
    if (!enabled) this.editor?.clear();
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

  private mergedIntent(): InputIntent {
    if (this.avatarDisabled) {
      return { direction: { x: 0, y: 0 }, intensity: 0, held: false, disabled: true };
    }
    if (this.editMode) {
      return { direction: { x: 0, y: 0 }, intensity: 0, held: false };
    }
    const pointer = this.pointer?.intent;
    if (pointer && pointer.intensity > 0) return pointer;
    const keyboard = this.keyboard?.intent;
    if (keyboard && keyboard.intensity > 0) return keyboard;
    return { direction: { x: 0, y: 0 }, intensity: 0, held: false };
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
      const entities = this.session.entitiesToDraw(nowMs);
      this.latestEntities = entities;
      scene.update(entities, deltaMs);
      scene.setThumbstick(this.editMode ? undefined : this.pointer?.gesture);
      this.options.onDiagnostics?.(this.diagnostics());
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

  // ---------- durable mutations ----------

  spawnItem(definitionId: string, at: Vec2, rotation = 0): void {
    this.session.spawnItem(definitionId, at, rotation);
  }

  moveItem(entityId: string, transform: Transform, preview = false): void {
    this.session.moveItem(entityId, transform, preview);
  }

  rotateItem(entityId: string, rotation: number): void {
    this.session.rotateItem(entityId, rotation);
  }

  setItemConfig(entityId: string, config: unknown): void {
    this.session.setItemConfig(entityId, config);
  }

  deleteItem(entityId: string): void {
    this.session.deleteItem(entityId);
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
    };
  }
}
