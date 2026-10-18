import { activeJunction, nextJunction, selectedRoute, type CourseFeatures, type CourseJunction, type RouteChoice, type RouteDriver } from "./race-course.ts";

export type RouteGuidance = {
  phase: "approach" | "branch" | "complete";
  junction?: CourseJunction;
  junctionNumber?: number;
  route?: RouteChoice;
  explicitChoice: boolean;
  locked: boolean;
  direction: string;
  instruction: string;
  currentRoad: string;
  selection: string;
  distance: number;
};

/** Presentation only. Every choice comes from server routeChoices or its default. */
export function routeGuidance(course: CourseFeatures, driver: RouteDriver): RouteGuidance {
  const active = activeJunction(course, driver.progress);
  const junction = active ?? nextJunction(course, driver.progress);
  if (!junction) return { phase: "complete", explicitChoice: false, locked: true, direction: "直進", instruction: "本道を直進", currentRoad: "本道", selection: course.junctions?.length ? "すべての分岐を通過" : "分岐なし", distance: 0 };
  const route = selectedRoute(junction, driver);
  const direction = route === "left" ? "左" : "右";
  const junctionNumber = (course.junctions?.indexOf(junction) ?? 0) + 1;
  const explicitChoice = driver.routeChoices?.[junction.id] != null;
  // Match the server's boundary guard, including its floating-point tolerance.
  const locked = driver.progress >= junction.start - 1e-7;
  return { phase: active ? "branch" : "approach", junction, junctionNumber, route, direction, explicitChoice, locked,
    instruction: active ? `${direction}ルートを走行中` : `${direction}へ進む`,
    currentRoad: active ? `分岐${junctionNumber}・${direction}ルート / ${junction.routes[route].name}` : "本道",
    selection: active || locked ? "進路確定" : explicitChoice ? "選択済み・入口まで変更可能" : "未操作・既定の進路",
    distance: Math.max(0, active ? junction.end - driver.progress : junction.start - driver.progress) };
}
