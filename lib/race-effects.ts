/** All effect timing comes from server snapshots, including completed effects. */
export type RaceEffectState = {
  jumpStartedAt?: number;
  jumpEndsAt?: number;
  jumpReadyAt?: number;
  spinStartedAt?: number;
  spinEndsAt?: number;
  spinProgress?: number;
  spinLane?: number;
};

export function raceEffectsAt(player: RaceEffectState, now: number, phase = "racing") {
  // Terminal snapshots deliberately stop the race clock. Settle the vehicles
  // instead of freezing an unfinished effect until another network response.
  const running = phase === "racing";
  const jumpStart = player.jumpStartedAt ?? Infinity;
  const jumpEnd = player.jumpEndsAt ?? -Infinity;
  const airborne = running && jumpStart <= now && now < jumpEnd;
  const jumpFraction = airborne ? (now - jumpStart) / (jumpEnd - jumpStart) : 0;
  const spinStart = player.spinStartedAt ?? Infinity;
  const spinEnd = player.spinEndsAt ?? -Infinity;
  const spinning = running && spinStart <= now && now < spinEnd;
  const spinFraction = spinning ? (now - spinStart) / (spinEnd - spinStart) : 0;
  return {
    airborne,
    height: airborne ? Math.sin(Math.PI * jumpFraction) * 3.2 : 0,
    jumpFraction,
    jumpRemainingMs: airborne ? jumpEnd - now : 0,
    // A short ground-level ring makes the authoritative landing visible.
    landing: running && Number.isFinite(jumpEnd) && now >= jumpEnd && now < jumpEnd + 260 ? 1 - (now - jumpEnd) / 260 : 0,
    spinning,
    spinRadians: spinFraction * Math.PI * 6,
    spinRemainingMs: spinning ? spinEnd - now : 0,
  };
}
