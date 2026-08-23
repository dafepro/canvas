import { Application, Container, Graphics } from "pixi.js";
import type {
  CanvasDefinition,
  ItemDefinition,
  StaticColliderDefinition,
  Transform,
} from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";
import type { DragGesture } from "../input/pointer-drag-controller.js";
import type { ItemEditState } from "../input/item-edit-controller.js";
import { Camera } from "./camera.js";
import { EffectSystem } from "./effect-system.js";

export interface SceneOptions {
  background?: number;
  /** Draw collider outlines and region bands (spec 21.4). */
  debug?: boolean;
}

interface SpriteRecord {
  display: Container;
  definitionId: string;
  variant?: string;
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
  ) {
    for (const definition of definitions) {
      this.definitions.set(definition.definitionId, definition);
    }
    this.camera = new Camera(canvas);
    this.effects = new EffectSystem(this.camera);
    this.debug = options.debug ?? false;
  }

  async mount(element: HTMLElement): Promise<void> {
    await this.app.init({
      background: this.options.background ?? 0x0b1020,
      resizeTo: element,
      antialias: true,
      preference: "webgl",
    });
    element.appendChild(this.app.canvas);

    this.world.addChild(this.backgroundLayer, this.entityLayer, this.debugLayer);
    this.uiLayer.addChild(this.editOverlay, this.thumbstick);
    this.app.stage.addChild(this.world, this.effects.layer, this.uiLayer);
    this.resize();
    this.app.renderer.on("resize", () => this.resize());
    this.drawBackground();
  }

  private resize(): void {
    this.camera.fit(this.app.renderer.width, this.app.renderer.height);
    this.drawBackground();
  }

  private drawBackground(): void {
    this.backgroundLayer.removeChildren();
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

    // Region bands make the environment gradient visible (spec 21.4).
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
      z: selected?.z,
    };
    const width = size.width * this.camera.scale;
    const height = size.height * this.camera.scale;
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
      existing.variant === entity.variant
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
    };
    this.entityLayer.addChild(display);
    this.sprites.set(entity.id, record);
    return record;
  }

  /**
   * Draws a placeholder shape from the item definition. Replace this with a
   * texture atlas sprite factory when art exists (spec 9.1).
   */
  private buildDisplay(entity: RenderEntity): Container {
    const container = new Container();
    const scale = this.camera.scale;

    if (entity.kind === "avatar") {
      const radius = 1.2 * scale;
      container.addChild(
        new Graphics()
          .circle(0, 0, radius)
          .fill({ color: 0x8ecae6 })
          .stroke({ color: 0xffffff, width: 2 }),
      );
      // A short nose shows the facing direction.
      container.addChild(
        new Graphics().moveTo(0, 0).lineTo(radius, 0).stroke({ color: 0xffffff, width: 2 }),
      );
      return container;
    }

    const definition = this.definitions.get(entity.definitionId);
    const size = definition?.visual.size ?? { width: 2, height: 2 };
    const placeholder = definition?.visual.placeholder;
    const variantColor = entity.variant
      ? definition?.visual.variants?.[entity.variant]?.color
      : undefined;
    const color = variantColor ?? placeholder?.color ?? 0xf1faee;
    const graphics = new Graphics();

    switch (placeholder?.shape ?? "rect") {
      case "circle":
        graphics.circle(0, 0, (size.width / 2) * scale).fill({ color });
        break;
      case "triangle":
        graphics
          .poly([
            0,
            -(size.height / 2) * scale,
            (size.width / 2) * scale,
            (size.height / 2) * scale,
            -(size.width / 2) * scale,
            (size.height / 2) * scale,
          ])
          .fill({ color });
        break;
      default:
        graphics
          .rect(
            -(size.width / 2) * scale,
            -(size.height / 2) * scale,
            size.width * scale,
            size.height * scale,
          )
          .fill({ color });
    }
    container.addChild(graphics);

    if (this.debug) {
      for (const collider of definition?.colliders ?? []) {
        const outline = new Graphics();
        const offset = collider.offset ?? { x: 0, y: 0 };
        const isSensor = collider.sensor ?? collider.role.endsWith("Sensor");
        switch (collider.shape.type) {
          case "circle":
            outline.circle(offset.x * scale, offset.y * scale, collider.shape.radius * scale);
            break;
          case "rect":
            outline.rect(
              (offset.x - collider.shape.width / 2) * scale,
              (offset.y - collider.shape.height / 2) * scale,
              collider.shape.width * scale,
              collider.shape.height * scale,
            );
            break;
          case "capsule":
            outline.roundRect(
              (offset.x - collider.shape.radius) * scale,
              (offset.y - collider.shape.halfHeight - collider.shape.radius) * scale,
              collider.shape.radius * 2 * scale,
              (collider.shape.halfHeight + collider.shape.radius) * 2 * scale,
              collider.shape.radius * scale,
            );
            break;
          case "polygon":
            outline.poly(
              collider.shape.vertices.flatMap((vertex) => [
                (vertex.x + offset.x) * scale,
                (vertex.y + offset.y) * scale,
              ]),
            );
            break;
        }
        outline.stroke({ color: isSensor ? 0x4cc9f0 : 0xff006e, width: 1, alpha: 0.9 });
        container.addChild(outline);
      }
    }
    return container;
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
  setThumbstick(gesture?: DragGesture): void {
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
    this.effects.destroy();
    this.app.destroy(true, { children: true });
  }
}
