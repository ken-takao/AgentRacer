/** Shared course metadata. Route choices are game inputs, not spectator effects. */
export type RouteChoice = "left" | "right";
export type CourseLayout = "harbor" | "alpine" | "metro";
export type CourseRoute = {
  name: string;
  description: string;
  speedMultiplier: number;
  blockedLanes: (0 | 1 | 2)[];
};
export type CourseJunction = {
  id: string;
  name: string;
  start: number;
  end: number;
  defaultRoute: RouteChoice;
  routes: Record<RouteChoice, CourseRoute>;
};
export type CourseFeatures = { layout?: CourseLayout; junctions?: CourseJunction[] };
export type RouteDriver = { progress: number; routeChoices?: Record<string, RouteChoice> };

export const COURSE_NAMES: Record<CourseLayout, string> = {
  harbor: "HARBOR CROSS", alpine: "ALPINE SWITCHBACK", metro: "METRO LOOP",
};

export function createCourseFeatures(seed: string, length: number): Required<CourseFeatures> {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const word = hash >>> 0;
  const layouts: CourseLayout[] = ["harbor", "alpine", "metro"];
  const junctions = [[0.26, 0.44], [0.61, 0.8]].map(([start, end], index): CourseJunction => {
    const fast: RouteChoice = ((word >>> (index + 2)) & 1) === 0 ? "left" : "right";
    const safe: RouteChoice = fast === "left" ? "right" : "left";
    const lane = ((word >>> (index + 6)) % 3) as 0 | 1 | 2;
    const risky: CourseRoute = { name: "TECHNICAL", description: "速い分岐・障害物2か所", speedMultiplier: 1.18, blockedLanes: [lane, ((lane + 1) % 3) as 0 | 1 | 2] };
    const wide: CourseRoute = { name: "WIDE", description: "ゆったりした分岐・障害物なし", speedMultiplier: 0.94, blockedLanes: [] };
    return { id: `fork-${index + 1}`, name: index === 0 ? "SPLIT RIDGE" : "CROSSOVER", start: length * start, end: length * end,
      defaultRoute: safe, routes: fast === "left" ? { left: risky, right: wide } : { left: wide, right: risky } };
  });
  return { layout: layouts[word % layouts.length], junctions };
}

export function activeJunction(course: CourseFeatures, progress: number): CourseJunction | undefined {
  return course.junctions?.find(j => progress >= j.start && progress < j.end);
}

export function nextJunction(course: CourseFeatures, progress: number): CourseJunction | undefined {
  return course.junctions?.find(j => progress < j.end);
}

export function selectedRoute(junction: CourseJunction, driver: Pick<RouteDriver, "routeChoices">): RouteChoice {
  return driver.routeChoices?.[junction.id] ?? junction.defaultRoute;
}

/** A branch key is separate from lane. Opposite forks never share a road surface. */
export function roadKey(course: CourseFeatures, driver: RouteDriver, progress = driver.progress): string {
  const junction = activeJunction(course, progress);
  return junction ? `${junction.id}:${selectedRoute(junction, driver)}` : "main";
}

export function routeSpeedMultiplier(course: CourseFeatures, driver: RouteDriver, progress = driver.progress): number {
  const junction = activeJunction(course, progress);
  return junction ? junction.routes[selectedRoute(junction, driver)].speedMultiplier : 1;
}
