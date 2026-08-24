import { AnimatedSprite, Container, Graphics, Sprite, type Texture } from "pixi.js";
import type { ItemDefinition } from "@canvas-physics/core";
import type { LoadedAssetBundle } from "../assets/index.js";
import type { RenderEntity } from "../simulation/messages.js";

export function buildEntityDisplay(
  entity: RenderEntity,
  definition: ItemDefinition | undefined,
  scale: number,
  assets?: LoadedAssetBundle<Texture>,
  debug = false,
): Container {
  const container = new Container();

  if (entity.kind === "avatar" && !definition) {
    const radius = 1.2 * scale;
    container.addChild(
      new Graphics()
        .circle(0, 0, radius)
        .fill({ color: 0x8ecae6 })
        .stroke({ color: 0xffffff, width: 2 }),
    );
    container.addChild(
      new Graphics().moveTo(0, 0).lineTo(radius, 0).stroke({ color: 0xffffff, width: 2 }),
    );
    return container;
  }

  const visual = definition?.visual;
  const size = visual?.size ?? { width: 2, height: 2 };
  const variant = entity.variant ? visual?.variants?.[entity.variant] : undefined;
  const tint = entity.tint ?? variant?.color;
  const animation = entity.animation ? visual?.animations?.[entity.animation] : undefined;
  const animationTextures = animation?.frames
    .map((id) => assets?.texture(id))
    .filter((texture): texture is Texture => texture !== undefined);
  const hasCompleteAnimation =
    animation !== undefined &&
    animation.frames.length > 0 &&
    animationTextures?.length === animation.frames.length;

  if (hasCompleteAnimation && animationTextures) {
    const sprite = new AnimatedSprite({
      textures: animationTextures,
      animationSpeed: animation.fps / 60,
      autoPlay: true,
      loop: animation.loop,
      anchor: visual?.anchor ?? 0.5,
    });
    sprite.width = size.width * scale;
    sprite.height = size.height * scale;
    if (tint !== undefined) sprite.tint = tint;
    container.addChild(sprite);
  } else {
    const spriteId = variant?.spriteId ?? visual?.spriteId;
    const texture = spriteId ? assets?.texture(spriteId) : undefined;
    if (texture) {
      const sprite = new Sprite({ texture, anchor: visual?.anchor ?? 0.5 });
      sprite.width = size.width * scale;
      sprite.height = size.height * scale;
      if (tint !== undefined) sprite.tint = tint;
      container.addChild(sprite);
    } else {
      container.addChild(drawPlaceholder(definition, size, scale, tint));
    }
  }

  if (debug) addColliderOutlines(container, definition, scale);
  container.zIndex = visual?.zIndex ?? 0;
  return container;
}

function drawPlaceholder(
  definition: ItemDefinition | undefined,
  size: { width: number; height: number },
  scale: number,
  variantColor?: number,
): Graphics {
  const placeholder = definition?.visual.placeholder;
  const color = variantColor ?? placeholder?.color ?? 0xf1faee;
  const graphics = new Graphics();
  switch (placeholder?.shape ?? "rect") {
    case "circle":
      return graphics.circle(0, 0, (size.width / 2) * scale).fill({ color });
    case "triangle":
      return graphics
        .poly([
          0,
          -(size.height / 2) * scale,
          (size.width / 2) * scale,
          (size.height / 2) * scale,
          -(size.width / 2) * scale,
          (size.height / 2) * scale,
        ])
        .fill({ color });
    default:
      return graphics
        .rect(
          -(size.width / 2) * scale,
          -(size.height / 2) * scale,
          size.width * scale,
          size.height * scale,
        )
        .fill({ color });
  }
}

function addColliderOutlines(
  container: Container,
  definition: ItemDefinition | undefined,
  scale: number,
): void {
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
