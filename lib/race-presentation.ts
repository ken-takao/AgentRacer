import { RACE_RULES } from "./race-engine.ts";
import type { CourseFeatures, RouteChoice } from "./race-course.ts";
type Snapshot = {
  phase: string; createdAt: number; updatedAt: number;
  version?: number; course?: CourseFeatures;
  players: Record<"red" | "blue", { progress: number; lane: number; routeChoices?: Record<string, RouteChoice> }>;
};

function interpolationCrossesContact(previous: Snapshot, current: Snapshot) {
  let entry = 0, exit = 1;
  for (const [axis, extent] of [["progress", RACE_RULES.carLength], ["lane", RACE_RULES.carWidth]] as const) {
    const start = previous.players.red[axis] - previous.players.blue[axis];
    const end = current.players.red[axis] - current.players.blue[axis];
    const delta = end - start, limit = extent - 1e-7;
    if (Math.abs(delta) < 1e-10) {
      if (Math.abs(start) >= limit) return false;
      continue;
    }
    const a = (-limit - start) / delta, b = (limit - start) / delta;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (entry >= exit) return false;
  }
  return entry < exit;
}

/** Display a short buffer of known positions; never predict beyond server collisions. */
export function interpolateRace<T extends Snapshot>(previous: T | undefined, current: T, elapsedMs: number): T {
  if (!previous || current.phase !== "racing" || previous.phase !== "racing" || previous.createdAt !== current.createdAt || current.updatedAt <= previous.updatedAt) return current;
  // Check the entire interval so a frame never jumps forward and then back.
  // This also conservatively skips smoothing when cars cross on separate branches.
  if (current.version === 2 && interpolationCrossesContact(previous, current)) return current;
  const duration = Math.max(1, Math.min(1000, current.updatedAt - previous.updatedAt));
  const t = Math.min(1, Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs / duration : 0));
  const players = { ...current.players };
  for (const id of ["red", "blue"] as const) {
    const from = previous.players[id], to = current.players[id];
    players[id] = { ...to, progress: from.progress + (to.progress - from.progress) * t, lane: from.lane + (to.lane - from.lane) * t };
  }
  return { ...current, players };
}
