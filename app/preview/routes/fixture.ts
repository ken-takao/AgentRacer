import { circuitAtProgress } from "../../../lib/circuit-geometry.ts";
import { createRace, publicView, type Lane } from "../../../lib/race-engine.ts";
import { activeJunction, type CourseLayout, type RouteChoice } from "../../../lib/race-course.ts";

export const ROUTE_STAGES = ["before", "entry", "middle", "premerge", "exit", "overpass", "underpass"] as const;
export type RouteStage = typeof ROUTE_STAGES[number];
export type FixtureOptions = { layout: CourseLayout; junction: 1 | 2; red: RouteChoice | "default"; blue: RouteChoice | "default"; stage: RouteStage; progress?: number; redLane: Lane; blueLane: Lane };
export const DEFAULT_FIXTURE: FixtureOptions = { layout: "harbor", junction: 1, red: "left", blue: "right", stage: "entry", redLane: 0, blueLane: 2 };
const seeds = new Map<CourseLayout, string>();
export function routeFixture(options: FixtureOptions) {
  let seed = seeds.get(options.layout);
  if (!seed) {
    for (let index = 0; index < 100; index++) {
      const candidate = `route-inspection-${index}`;
      if (createRace(candidate, 0).course.layout === options.layout) { seed = candidate; seeds.set(options.layout, candidate); break; }
    }
  }
  const state = createRace(seed!, 10_000);
  state.phase = "racing"; state.startedAt = state.updatedAt = 10_000;
  const junction = state.course.junctions![options.junction - 1];
  let progress = options.progress ?? ({ before: junction.start - 6, entry: junction.start + .1, middle: (junction.start + junction.end) / 2, premerge: junction.end - .1, exit: junction.end + .1, overpass: 0, underpass: 0 })[options.stage];
  if (options.progress == null && (options.stage === "overpass" || options.stage === "underpass")) {
    let distance = Infinity;
    for (let p = 0; p < state.course.length; p += .05) {
      const point = circuitAtProgress(p, 0, state.course.length, state.course);
      if (options.stage === "overpass" ? point.y < 8 : point.y >= 8) continue;
      const candidate = Math.hypot(point.x, point.z);
      if (candidate < distance) { progress = p; distance = candidate; }
    }
  }
  for (const id of ["red", "blue"] as const) {
    const player = state.players[id];
    player.joined = player.ready = true; player.progress = progress;
    player.lane = player.targetLane = id === "red" ? options.redLane : options.blueLane;
    player.routeChoices = options[id] === "default" ? {} : { [junction.id]: options[id] };
  }
  // Explicit fixture props exercise the same route-local positioning as server props.
  // They are not placed through an admin endpoint and never enter a live race.
  const propProgress = Math.min(state.course.length - 1, progress + 3);
  const propJunction = activeJunction(state.course, propProgress);
  state.course.obstacles = [];
  for (const route of propJunction ? ["left", "right"] as const : [undefined]) {
    for (const [i, assetId] of ["traffic_cone", "banana_peel", "water_barrier"].entries()) {
      state.course.obstacles.push({ id: `fixture-${route ?? "main"}-${assetId}`, assetId, progress: propProgress, blockedLane: i as Lane, ...(route && propJunction ? { route, junctionId: propJunction.id } : {}) });
    }
  }
  return { ...publicView(state), now: state.updatedAt };
}

export function readFixtureQuery(query: URLSearchParams): FixtureOptions {
  const oneOf = <T extends string>(value: string | null, choices: readonly T[], fallback: T): T => choices.includes(value as T) ? value as T : fallback;
  const p = query.get("progress");
  const lane = (name: string): Lane => { const value = Number(query.get(name) ?? (name === "redLane" ? 0 : 2)); return value === 0 || value === 2 ? value : 1; };
  return { layout: oneOf(query.get("layout"), ["harbor", "alpine", "metro"], "harbor"), junction: query.get("junction") === "2" ? 2 : 1,
    red: oneOf(query.get("red"), ["left", "right", "default"], "left"), blue: oneOf(query.get("blue"), ["left", "right", "default"], "right"),
    stage: oneOf(query.get("stage"), ROUTE_STAGES, "entry"), redLane: lane("redLane"), blueLane: lane("blueLane"),
    ...(p != null && Number.isFinite(Number(p)) ? { progress: Math.max(0, Math.min(200, Number(p))) } : {}) };
}
