import { RACE_RULES } from "./race-engine.ts";
import { activeJunction, selectedRoute, type CourseFeatures, type RouteChoice } from "./race-course.ts";
import type { RaceEffectState } from "./race-effects.ts";
type Snapshot = {
  phase: string; createdAt: number; updatedAt: number; now?: number;
  version?: number; carInteraction?: "solid" | "ghost"; course?: CourseFeatures;
  players: Record<"red" | "blue", { progress: number; lane: number; routeChoices?: Record<string, RouteChoice> } & RaceEffectState>;
};

function interpolateWithStops(from: Snapshot["players"]["red"], to: Snapshot["players"]["red"], axis: "progress" | "lane", start: number, end: number, now: number) {
  const anchors = [{ at: start, value: from[axis] }, { at: end, value: to[axis] }];
  const stops = [from, to].filter((player, index, all) => player.spinStartedAt != null && player.spinEndsAt != null
    && all.findIndex(p => p.spinStartedAt === player.spinStartedAt) === index);
  for (const stop of stops) {
    const value = axis === "progress" ? stop.spinProgress : stop.spinLane;
    if (value == null || stop.spinEndsAt! <= start || stop.spinStartedAt! >= end) continue;
    if (now >= stop.spinStartedAt! && now <= stop.spinEndsAt!) return value;
    for (const at of [stop.spinStartedAt!, stop.spinEndsAt!]) if (at > start && at < end) anchors.push({ at, value });
  }
  anchors.sort((a, b) => a.at - b.at);
  const right = anchors.findIndex(anchor => anchor.at >= now);
  if (right <= 0) return anchors[0].value;
  const a = anchors[right - 1], b = anchors[right];
  return a.value + (b.value - a.value) * (now - a.at) / Math.max(1, b.at - a.at);
}

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

function linearSegmentCrossesContact(previous: Snapshot, current: Snapshot) {
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

function interpolationCrossesContact(previous: Snapshot, current: Snapshot) {
  // Coincident distance/lane values on two stable, distinct roads are not contact.
  if (remainOnSeparateBranches(previous, current)) return false;
  // A banana changes the display trajectory from one line to several segments.
  // Test every segment, including the stopped part: checking endpoints alone can
  // put a following car inside the stopped car even when both snapshots are safe.
  const times = new Set([previous.updatedAt, current.updatedAt]);
  for (const snapshot of [previous, current]) for (const player of Object.values(snapshot.players)) {
    for (const at of [player.spinStartedAt, player.spinEndsAt]) {
      if (at != null && at > previous.updatedAt && at < current.updatedAt) times.add(at);
    }
  }
  const atTime = (now: number): Snapshot => ({
    ...current,
    players: Object.fromEntries((["red", "blue"] as const).map(id => {
      const from = previous.players[id], to = current.players[id];
      return [id, { ...to,
        progress: interpolateWithStops(from, to, "progress", previous.updatedAt, current.updatedAt, now),
        lane: interpolateWithStops(from, to, "lane", previous.updatedAt, current.updatedAt, now),
      }];
    })) as Snapshot["players"],
  });
  const knots = [...times].sort((a, b) => a - b).map(atTime);
  return knots.some((snapshot, index) => index > 0 && linearSegmentCrossesContact(knots[index - 1], snapshot));
}

/** Display a short buffer of known positions; never predict beyond server collisions. */
export function interpolateRace<T extends Snapshot>(previous: T | undefined, current: T, elapsedMs: number): T {
  if (!previous || current.phase !== "racing" || previous.phase !== "racing" || previous.createdAt !== current.createdAt || current.updatedAt <= previous.updatedAt) return current;
  // Check the entire interval so a frame never jumps forward and then back.
  // Solid-car split/merge transitions stay conservative; ghost cars can pass
  // through one another and must keep interpolating smoothly during an overtake.
  if (current.version === 2 && current.carInteraction !== "ghost" && interpolationCrossesContact(previous, current)) return current;
  const duration = Math.max(1, Math.min(1000, current.updatedAt - previous.updatedAt));
  const t = Math.min(1, Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs / duration : 0));
  const now = previous.updatedAt + (current.updatedAt - previous.updatedAt) * t;
  const players = { ...current.players };
  for (const id of ["red", "blue"] as const) {
    const from = previous.players[id], to = current.players[id];
    players[id] = { ...to,
      progress: interpolateWithStops(from, to, "progress", previous.updatedAt, current.updatedAt, now),
      lane: interpolateWithStops(from, to, "lane", previous.updatedAt, current.updatedAt, now),
    };
  }
  // Effect endpoints may arrive after a short jump has already ended. Replaying
  // them against this same buffered clock preserves the full jump and landing.
  return { ...current, now, players };
}
