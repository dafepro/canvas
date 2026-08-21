import type { Vec2 } from "../math/vec2.js";

export type ShapeDefinition =
  | { type: "circle"; radius: number }
  | { type: "rect"; width: number; height: number }
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "polygon"; vertices: Vec2[] };

/** A region shape in world space. */
export type RegionShape =
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "circle"; x: number; y: number; radius: number };

export const regionContains = (shape: RegionShape, p: Vec2): boolean => {
  if (shape.type === "rect") {
    return (
      p.x >= shape.x &&
      p.x <= shape.x + shape.w &&
      p.y >= shape.y &&
      p.y <= shape.y + shape.h
    );
  }
  return Math.hypot(p.x - shape.x, p.y - shape.y) <= shape.radius;
};
