/** Stable product-owned reputation display; Canvas does not interpret stars. */
export const playerStarCount = (participantId: string): number => {
  let hash = 2_166_136_261;
  for (const character of participantId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 5 + 1;
};

export interface PlayerStarPosition {
  readonly x: number;
  readonly y: number;
  readonly rotationDegrees: number;
}

export interface PlayerOverlayGeometry {
  readonly stars: readonly Readonly<PlayerStarPosition>[];
  readonly nameOffsetY: number;
}

// Matches the consumer-owned avatar visual footprint around its anchor. The
// star positions follow the top ellipse instead of forming a detached row.
const AVATAR_HALF_WIDTH = 2.25;
const AVATAR_TOP_RADIUS = 4.1;
const AVATAR_BOTTOM = 3.4;
const STAR_OUTSET_PX = 2;
const NAME_GAP_PX = 1;

export const playerOverlayGeometry = (
  starCount: number,
  viewportScale: number,
): Readonly<PlayerOverlayGeometry> => {
  const count = Math.max(1, Math.min(5, Math.round(starCount)));
  const arcDegrees = count === 1 ? 0 : Math.min(120, 30 * (count - 1));
  const startDegrees = -90 - arcDegrees / 2;
  const stepDegrees = count === 1 ? 0 : arcDegrees / (count - 1);
  const horizontalRadius = AVATAR_HALF_WIDTH * viewportScale + STAR_OUTSET_PX;
  const verticalRadius = AVATAR_TOP_RADIUS * viewportScale + STAR_OUTSET_PX;
  const stars = Array.from({ length: count }, (_, index) => {
    const degrees = startDegrees + stepDegrees * index;
    const radians = degrees * Math.PI / 180;
    return Object.freeze({
      x: Math.cos(radians) * horizontalRadius,
      y: Math.sin(radians) * verticalRadius,
      rotationDegrees: (degrees + 90) * 0.3,
    });
  });
  return Object.freeze({
    stars: Object.freeze(stars),
    nameOffsetY: AVATAR_BOTTOM * viewportScale + NAME_GAP_PX,
  });
};
