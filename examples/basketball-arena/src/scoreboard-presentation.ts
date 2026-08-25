export interface ScoreboardDisplay {
  text: string;
  characters: number;
}

/** Keep the in-world display legible without changing the authoritative score. */
export const formatScoreboardScore = (
  score: number,
  maximumDisplayedScore = 99,
): ScoreboardDisplay => {
  const maximum = Math.max(0, Math.floor(maximumDisplayedScore));
  const normalized = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  const text = normalized > maximum ? `${maximum}+` : String(normalized);
  return { text, characters: text.length };
};
