import type { Vec2 } from "../math/vec2.js";
import type { CanvasDefinition, EdgePolicy } from "../model/canvas-definition.js";

export type EdgeName = "top" | "right" | "bottom" | "left";

export interface EdgeCrossing {
  edge: EdgeName;
  policy: EdgePolicy;
}

export interface EdgeResolution {
  crossings: EdgeCrossing[];
  /** New position when a policy moves the body. */
  position?: Vec2;
  /** New velocity when a policy zeroes motion. */
  velocity?: Vec2;
  /** True when the body must leave active simulation and respawn. */
  respawn?: boolean;
  spawnPointId?: string;
}

/**
 * Spec 3.2. Applies the per-edge policy for a body that left the canvas. `solid`
 * needs no work here because a static collider stops the body.
 */
export const resolveEdges = (
  canvas: CanvasDefinition,
  position: Vec2,
  velocity: Vec2,
  radius = 0,
): EdgeResolution => {
  const { width, height } = canvas.size;
  const crossings: EdgeCrossing[] = [];
  let next = { ...position };
  let nextVelocity: Vec2 | undefined;
  let respawn = false;

  const check = (edge: EdgeName, crossed: boolean) => {
    if (!crossed) return;
    const policy = canvas.edges[edge];
    if (policy === "solid") return;
    crossings.push({ edge, policy });
    if (policy === "wrap") {
      // Wrapping preserves velocity and rotation. The body arrives just inside
      // the opposite edge. A position outside that edge would fall out of a
      // canvas whose opposite edge is solid.
      if (edge === "left") next.x = width - radius;
      if (edge === "right") next.x = radius;
      if (edge === "top") next.y = height - radius;
      if (edge === "bottom") next.y = radius;
    } else if (policy === "respawn") {
      respawn = true;
    }
  };

  check("left", position.x < -radius);
  check("right", position.x > width + radius);
  check("top", position.y < -radius);
  check("bottom", position.y > height + radius);

  if (respawn) {
    const spawn = canvas.spawnPoints[0];
    next = spawn ? { ...spawn.position } : { x: width / 2, y: height / 2 };
    nextVelocity = { x: 0, y: 0 };
  }

  const resolution: EdgeResolution = { crossings };
  if (crossings.length > 0) resolution.position = next;
  if (nextVelocity) resolution.velocity = nextVelocity;
  if (respawn) {
    resolution.respawn = true;
    if (canvas.spawnPoints[0]) resolution.spawnPointId = canvas.spawnPoints[0].id;
  }
  return resolution;
};
