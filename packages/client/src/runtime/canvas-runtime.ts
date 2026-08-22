import type {
  CanvasDefinition,
  ItemDefinition,
  Transform,
  Vec2,
} from "@canvas-physics/core";
import type { RoomTransport } from "../net/transport.js";
import { PixiScene, type SceneOptions } from "../render/pixi-scene.js";
import { KeyboardController } from "../input/keyboard-controller.js";
import { PointerDragController } from "../input/pointer-drag-controller.js";
import type { SimulationDriver } from "../simulation/driver.js";
import {
  RoomSession,
  type InputIntent,
  type RoomSessionRates,
  type SessionDiagnostics,
} from "./room-session.js";

export interface CanvasRuntimeOptions {
  canvasId: string;
  serverUrl: string;
  userId: string;
  displayName: string;
  mount: HTMLElement;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  driver?: SimulationDriver;
  /** Rates from spec 10.3. */
  rates?: RoomSessionRates;
  scene?: SceneOptions;
  onDiagnostics?: (diagnostics: RuntimeDiagnostics) => void;
  /** Addendum A1. Runs after the local avatar changes its disabled state. */
  onAvatarDisabledChange?: (disabled: boolean) => void;
}

export interface RuntimeDiagnostics extends SessionDiagnostics {
  renderFps: number;
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
  private keyboard?: KeyboardController;
  private renderFps = 0;
  private running = false;
  private visibilityListener?: () => void;
  private avatarDisabled = false;
  private disableKeyListener?: (event: KeyboardEvent) => void;

  constructor(private readonly options: CanvasRuntimeOptions) {
    this.session = new RoomSession({
      canvasId: options.canvasId,
      serverUrl: options.serverUrl,
      userId: options.userId,
      displayName: options.displayName,
      definitions: options.definitions,
      transport: options.transport,
      driver: options.driver,
      rates: options.rates,
      intent: () => this.mergedIntent(),
      onJoined: (canvas) => this.mountScene(canvas),
      onEffect: (emission) => this.scene?.effects.apply(emission),
    });
  }

  /** The coordination client, for an application that needs the raw events. */
  get client() {
    return this.session.client;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.session.start();
  }

  stop(): void {
    this.running = false;
    if (this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = undefined;
    }
    if (this.disableKeyListener) {
      window.removeEventListener("keydown", this.disableKeyListener);
      this.disableKeyListener = undefined;
    }
    this.pointer?.destroy();
    this.keyboard?.destroy();
    this.session.stop();
    this.scene?.destroy();
  }

  private async mountScene(canvas: CanvasDefinition): Promise<void> {
    this.scene = new PixiScene(canvas, this.options.definitions, this.options.scene);
    await this.scene.mount(this.options.mount);
    this.pointer = new PointerDragController(
      this.scene.app.canvas as unknown as HTMLElement,
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

  private mergedIntent(): InputIntent {
    if (this.avatarDisabled) {
      return { direction: { x: 0, y: 0 }, intensity: 0, held: false, disabled: true };
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
      scene.update(this.session.entitiesToDraw(nowMs), deltaMs);
      scene.setThumbstick(this.pointer?.gesture);
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
    this.visibilityListener = () => {
      this.session.setPageVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", this.visibilityListener);
  }

  // ---------- durable mutations ----------

  spawnItem(definitionId: string, at: Vec2, rotation = 0): void {
    this.session.spawnItem(definitionId, at, rotation);
  }

  moveItem(entityId: string, transform: Transform, preview = false): void {
    this.session.moveItem(entityId, transform, preview);
  }

  deleteItem(entityId: string): void {
    this.session.deleteItem(entityId);
  }

  diagnostics(): RuntimeDiagnostics {
    return { ...this.session.diagnostics(), renderFps: this.renderFps };
  }
}
