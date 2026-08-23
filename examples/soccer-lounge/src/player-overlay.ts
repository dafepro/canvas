/** Stable product-owned reputation display; Canvas does not interpret stars. */
export const playerStarCount = (participantId: string): number => {
  let hash = 2_166_136_261;
  for (const character of participantId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 5 + 1;
};

