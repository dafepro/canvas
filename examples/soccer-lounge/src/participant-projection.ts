import type { ParticipantAvatarProjector } from "@canvas-physics/client/runtime";

const stableHash = (value: string): number => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Soccer owns benches and team-side return points; Canvas owns the transition. */
export const projectSoccerParticipantAvatar: ParticipantAvatarProjector = (
  participant,
  { canvas, previousStatus },
) => {
  const hash = stableHash(participant.participantId);
  if (participant.status !== "active") {
    const bench = canvas.spawnPoints.find(({ id }) => id === "bench")?.position;
    if (!bench) return undefined;
    const slot = (hash % 9) - 4;
    return { position: { x: bench.x + slot * 4, y: bench.y } };
  }
  if (previousStatus === undefined || previousStatus === "active") return undefined;

  const spawnId = hash % 2 === 0 ? "home" : "away";
  const spawn = canvas.spawnPoints.find(({ id }) => id === spawnId)?.position;
  if (!spawn) return undefined;
  const lane = (Math.floor(hash / 2) % 5) - 2;
  return { position: { x: spawn.x, y: spawn.y + lane * 3 } };
};
