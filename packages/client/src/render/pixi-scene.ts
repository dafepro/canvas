import { Application, Container, Graphics, Sprite, type Texture } from "pixi.js";
import type {
  CanvasDefinition,
  ItemDefinition,
  StaticColliderDefinition,
  Transform,
} from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";
import type { AvatarPointerGesture } from "../input/avatar-pointer-interaction.js";
import type { ItemEditState } from "../input/item-edit-interaction.js";
import { Camera } from "./camera.js";
import { EffectSystem, type MotionTrailOptions } from "./effect-system.js";
import { buildEntityDisplay } from "./entity-display.js";
import type { LoadedAssetBundle } from "../assets/index.js";

export interface SceneOptions {
  background?: number;
  /** Draw collider outlines and region bands (spec 21.4). */
  debug?: boolean;
  /** Backing pixels per CSS pixel. Defaults to device density, capped at 2. */
  resolution?: number;
  /** Renderer-local, speed-scaled trails derived from interpolated entities. */
  motionTrails?: readonly MotionTrailOptions[];
}

export const resolveSceneResolution = (
  requested: number | undefined,
  deviceResolution = globalThis.devicePixelRatio ?? 1,
): number => {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  return Math.min(2, Math.max(1, deviceResolution));
};

interface SpriteRecord {
  display: Container;
  definitionId: string;
  variant?: string;
  tint?: number;
  animation?: string;
  animationEpoch?: number;
}

/**
 * Spec 9.1. Rendering stays on the main thread and is separate from physics.
 * Display transforms are interpolated, so network jitter does not shake sprites.
 */
export class PixiScene {
  readonly app = new Application();
  readonly camera: Camera;
  readonly effects: EffectSystem;
  private readonly world = new Container();
  private readonly backgroundLayer = new Container();
  private readonly entityLayer = new Container();
  private readonly debugLayer = new Container();
  private resizeObserver?: ResizeObserver;
  private readonly uiLayer = new Container();
  private readonly editOverlay = new Graphics();
  private readonly thumbstick = new Graphics();
  private readonly sprites = new Map<string, SpriteRecord>();
  private readonly definitions = new Map<string, ItemDefinition>();
  private readonly screenPositions = new Map<string, { x: number; y: number }>();
  private lastFrameMs = 0;
  private editState: ItemEditState = {};
  debug: boolean;

  constructor(
    private readonly canvas: CanvasDefinition,
    definitions: ItemDefinition[],
    private readonly options: SceneOptions = {},
    private readonly assets?: LoadedAssetBundle<Texture>,
  ) {
    for (const definition of definitions) {
      this.definitions.set(definition.definitionId, definition);
    }
    this.camera = new Camera(canvas);
    this.effects = new EffectSystem(this.camera);
    this.debug = options.debug ?? false;
    this.entityLayer.sortableChildren = true;
  }

  async mount(element: HTMLElement): Promise<void> {
    await this.app.init({
      background: this.options.background ?? 0x0b1020,
      resizeTo: element,
      antialias: true,
      autoDensity: true,
      resolution: resolveSceneResolution(this.options.resolution),
      preference: "webgl",
    });
    // Native pan/zoom handling can cancel a drag as it crosses the canvas edge.
    this.app.canvas.style.touchAction = "none";
    element.appendChild(this.app.canvas);

    this.world.addChild(this.backgroundLayer, this.entityLayer, this.debugLayer);
    this.uiLayer.addChild(this.editOverlay, this.thumbstick);
    this.app.stage.addChild(this.world, this.effects.layer, this.uiLayer);
    this.resize();
    this.app.renderer.on("resize", () => this.resize());
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width ?? element.clientWidth;
        const height = entry?.contentRect.height ?? element.clientHeight;
        if (width <= 0 || height <= 0) return;
        this.app.renderer.resize(Math.round(width), Math.round(height));
      });
      this.resizeObserver.observe(element);
    }
    this.drawBackground();
  }

  private resize(): void {
    this.camera.fit(this.app.renderer.width, this.app.renderer.height);
    for (const record of this.sprites.values()) {
      this.entityLayer.removeChild(record.display);
      record.display.destroy({ children: true });
    }
    this.sprites.clear();
    this.drawBackground();
  }

  private drawBackground(): void {
    for (const child of this.backgroundLayer.removeChildren()) {
      child.destroy({ children: true });
    }
    const { width, height } = this.canvas.size;
    const frame = new Graphics()
      .rect(
        this.camera.toScreenX(0),
        this.camera.toScreenY(0),
        width * this.camera.scale,
        height * this.camera.scale,
      )
      .fill({ color: this.options.background ?? 0x131a33 })
      .stroke({ color: 0x2a3566, width: 2 });
    this.backgroundLayer.addChild(frame);

    const backgroundTexture = this.canvas.backgroundAssetId
      ? this.assets?.texture(this.canvas.backgroundAssetId)
      : undefined;
    if (backgroundTexture) {
      const art = new Sprite({ texture: backgroundTexture });
      art.position.set(this.camera.toScreenX(0), this.camera.toScreenY(0));
      art.width = width * this.camera.scale;
      art.height = height * this.camera.scale;
      this.backgroundLayer.addChild(art);
    }

    if (this.debug) {
      // Region bands and collider geometry are diagnostic overlays (spec 21.4).
      for (const region of this.canvas.environment.regions ?? []) {
        const shape = region.shape;
        const band = new Graphics();
        if (shape.type === "rect") {
          band
            .rect(
              this.camera.toScreenX(shape.x),
              this.camera.toScreenY(shape.y),
              shape.w * this.camera.scale,
              shape.h * this.camera.scale,
            )
            .fill({ color: 0x2b4c7e, alpha: 0.25 });
        } else {
          band
            .circle(
              this.camera.toScreenX(shape.x),
              this.camera.toScreenY(shape.y),
              shape.radius * this.camera.scale,
            )
            .fill({ color: 0x2b4c7e, alpha: 0.25 });
        }
        this.backgroundLayer.addChild(band);
      }

      for (const geometry of this.canvas.staticGeometry) {
        this.backgroundLayer.addChild(this.drawStatic(geometry));
      }
    }
  }

  private drawStatic(geometry: StaticColliderDefinition): Graphics {
    const graphics = new Graphics();
    const sensor = geometry.role === "regionSensor";
    const color = sensor ? 0x4cc9f0 : 0x3f5185;
    const x = this.camera.toScreenX(geometry.position.x);
    const y = this.camera.toScreenY(geometry.position.y);
    const scale = this.camera.scale;

    switch (geometry.shape.type) {
      case "rect":
        graphics.rect(
          -(geometry.shape.width * scale) / 2,
          -(geometry.shape.height * scale) / 2,
          geometry.shape.width * scale,
          geometry.shape.height * scale,
        );
        break;
      case "circle":
        graphics.circle(0, 0, geometry.shape.radius * scale);
        break;
      case "capsule":
        graphics.roundRect(
          -geometry.shape.radius * scale,
          -(geometry.shape.halfHeight + geometry.shape.radius) * scale,
          geometry.shape.radius * 2 * scale,
          (geometry.shape.halfHeight + geometry.shape.radius) * 2 * scale,
          geometry.shape.radius * scale,
        );
        break;
      case "polygon":
        graphics.poly(
          geometry.shape.vertices.flatMap((vertex) => [vertex.x * scale, vertex.y * scale]),
        );
        break;
    }
    if (sensor) graphics.stroke({ color, width: 2, alpha: 0.9 });
    else graphics.fill({ color });
    graphics.position.set(x, y);
    graphics.rotation = geometry.rotation ?? 0;
    return graphics;
  }

  /** Replaces the drawn entity set. Absent ids are removed. */
  update(entities: RenderEntity[], deltaMs: number): void {
    const seen = new Set<string>();
    this.screenPositions.clear();

    for (const entity of entities) {
      seen.add(entity.id);
      const record = this.ensureSprite(entity);
      const screenX = this.camera.toScreenX(entity.x);
      const screenY = this.camera.toScreenY(entity.y);
      const elevation = entity.z ?? 0;
      record.display.position.set(screenX, screenY - elevation * this.camera.scale);
      record.display.rotation = entity.rotation;
      record.display.scale.set(entity.scale ?? 1);
      // Addendum A1. A disabled avatar stays visible but reads as inactive.
      record.display.alpha = entity.quarantined || entity.disabled ? 0.35 : 1;
      // Addendum A3. A body that waits for its respawn is out of the scene.
      record.display.visible = entity.respawning !== true;
      this.screenPositions.set(entity.id, {
        x: record.display.position.x,
        y: record.display.position.y,
      });
    }

    for (const [id, record] of this.sprites) {
      if (seen.has(id)) continue;
      this.entityLayer.removeChild(record.display);
      record.display.destroy({ children: true });
      this.sprites.delete(id);
    }

    this.effects.setPositions(this.screenPositions);
    this.effects.setMotionTrails(entities, this.options.motionTrails ?? []);
    this.effects.update(deltaMs);
    this.drawEditOverlay(entities);
  }

  setEditState(state: ItemEditState): void {
    this.editState = state;
    if (!state.selectedEntityId) this.editOverlay.clear();
  }

  private drawEditOverlay(entities: RenderEntity[]): void {
    this.editOverlay.clear();
    const selected = entities.find(
      (entity) => entity.id === this.editState.selectedEntityId,
    );
    const ghost = this.editState.ghost;
    if (!selected && !ghost) return;

    const definitionId = ghost?.definitionId ?? selected?.definitionId ?? "";
    const definition = this.definitions.get(definitionId);
    const size = definition?.visual.size ?? { width: 2, height: 2 };
    const transform: Transform = ghost?.transform ?? {
      x: selected?.x ?? 0,
      y: selected?.y ?? 0,
      rotation: selected?.rotation ?? 0,
      scale: selected?.scale ?? 1,
      z: selected?.z,
    };
    const itemScale = transform.scale ?? 1;
    const width = size.width * this.camera.scale * itemScale;
    const height = size.height * this.camera.scale * itemScale;
    this.editOverlay.position.set(
      this.camera.toScreenX(transform.x),
      this.camera.toScreenY(transform.y) - (transform.z ?? 0) * this.camera.scale,
    );
    this.editOverlay.rotation = transform.rotation;

    if (ghost) {
      const shape = definition?.visual.placeholder?.shape ?? "rect";
      if (shape === "circle") {
        this.editOverlay.circle(0, 0, width / 2);
      } else if (shape === "triangle") {
        this.editOverlay.poly([0, -height / 2, width / 2, height / 2, -width / 2, height / 2]);
      } else {
        this.editOverlay.rect(-width / 2, -height / 2, width, height);
      }
      this.editOverlay.fill({ color: 0xffd166, alpha: 0.28 });
    }

    this.editOverlay
      .rect(-width / 2 - 4, -height / 2 - 4, width + 8, height + 8)
      .stroke({ color: 0xffd166, width: 2, alpha: 0.95 });
  }

  private ensureSprite(entity: RenderEntity): SpriteRecord {
    const existing = this.sprites.get(entity.id);
    if (
      existing &&
      existing.definitionId === entity.definitionId &&
      existing.variant === entity.variant &&
      existing.tint === entity.tint &&
      existing.animation === entity.animation &&
      existing.animationEpoch === entity.animationEpoch
    ) {
      return existing;
    }
    if (existing) {
      this.entityLayer.removeChild(existing.display);
      existing.display.destroy({ children: true });
    }

    const display = this.buildDisplay(entity);
    const record: SpriteRecord = {
      display,
      definitionId: entity.definitionId,
      variant: entity.variant,
      tint: entity.tint,
      animation: entity.animation,
      animationEpoch: entity.animationEpoch,
    };
    this.entityLayer.addChild(display);
    this.sprites.set(entity.id, record);
    return record;
  }

  private buildDisplay(entity: RenderEntity): Container {
    const definition = this.definitions.get(entity.definitionId);
    return buildEntityDisplay(entity, definition, this.camera.scale, this.assets, this.debug);
  }

  /** Frames per second measured from the render ticker. */
  frameDelta(nowMs: number): number {
    const delta = this.lastFrameMs === 0 ? 16 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    return delta;
  }

  /**
   * Spec 6.1. Draws the drag as a thumb stick: a ring at the point the player
   * pressed and a knob in the direction of the drag. Pass no gesture to hide it.
   */
  setThumbstick(gesture?: AvatarPointerGesture): void {
    this.thumbstick.clear();
    if (!gesture) return;
    const dx = gesture.point.x - gesture.origin.x;
    const dy = gesture.point.y - gesture.origin.y;
    const distance = Math.hypot(dx, dy);
    const limit = gesture.rangePx;
    const scale = distance > limit ? limit / distance : 1;
    const knobX = gesture.origin.x + dx * scale;
    const knobY = gesture.origin.y + dy * scale;

    this.thumbstick
      .circle(gesture.origin.x, gesture.origin.y, limit)
      .stroke({ color: 0xf1faee, width: 2, alpha: 0.35 })
      .circle(gesture.origin.x, gesture.origin.y, 4)
      .fill({ color: 0xf1faee, alpha: 0.5 });
    if (distance > 0) {
      this.thumbstick
        .moveTo(gesture.origin.x, gesture.origin.y)
        .lineTo(knobX, knobY)
        .stroke({ color: 0xffd166, width: 2, alpha: 0.6 })
        .circle(knobX, knobY, 14)
        .fill({ color: 0xffd166, alpha: 0.25 + 0.5 * gesture.intensity })
        .stroke({ color: 0xffd166, width: 2, alpha: 0.8 });
    }
  }

  get uiContainer(): Container {
    return this.uiLayer;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.effects.destroy();
    this.app.destroy(true, { children: true });
  }
}
