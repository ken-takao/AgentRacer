import { RACE_RULES } from "./race-engine.ts";
import { activeJunction, selectedRoute, type CourseFeatures, type RouteChoice } from "./race-course.ts";
type Snapshot = {
  phase: string; createdAt: number; updatedAt: number;
  version?: number; course?: CourseFeatures;
  players: Record<"red" | "blue", { progress: number; lane: number; routeChoices?: Record<string, RouteChoice> }>;
};

function remainOnSeparateBranches(previous: Snapshot, current: Snapshot) {
  if (!previous.course || !current.course || previous.course.layout !== current.course.layout) return false;
  const branches = [previous, current].flatMap(snapshot => (["red", "blue"] as const).map(id => {
    const driver = snapshot.players[id];
    const junction = activeJunction(snapshot.course!, driver.progress);
    // Include neither fork mouth: a split or merge still needs the contact guard.
    return junction && driver.progress > junction.start && driver.progress < junction.end
      ? { junction, route: selectedRoute(junction, driver) } : undefined;
  }));
  const [beforeRed, beforeBlue, afterRed, afterBlue] = branches;
  if (!beforeRed || !beforeBlue || !afterRed || !afterBlue) return false;
  const reference = beforeRed.junction;
  return branches.every(branch => branch!.junction.id === reference.id
    && branch!.junction.start === reference.start && branch!.junction.end === reference.end
    && branch!.junction.defaultRoute === reference.defaultRoute)
    && beforeRed.route === afterRed.route && beforeBlue.route === afterBlue.route
    && beforeRed.route !== beforeBlue.route;
}

function interpolationCrossesContact(previous: Snapshot, current: Snapshot) {
  // Linear progress remains inside this same fork for the entire interval.
  // Coincident distance/lane values on its two distinct roads are not contact.
  if (remainOnSeparateBranches(previous, current)) return false;
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
  // Split/merge transitions stay conservative; stable separate branches can interpolate.
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
