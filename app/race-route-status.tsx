"use client";

import type { CourseFeatures, RouteDriver } from "../lib/race-course";
import { routeGuidance } from "../lib/route-guidance";
import "./race-route-status.css";

type RouteRace = { course: CourseFeatures; players: Record<"red" | "blue", RouteDriver> };
/** Shared spectator legend: direction refers to a fork, never a driving lane. */
export function RaceRouteStatus({ race, compact = false }: { race: RouteRace; compact?: boolean }) {
  if (!race.course.junctions?.length) return null;
  return <div className={`race-route-status${compact ? " is-compact" : ""}`} aria-label="赤と青の分岐進路">
    {(["red", "blue"] as const).map(id => {
      const guidance = routeGuidance(race.course, race.players[id]);
      return <div key={id} className={`route-status-driver is-${id}`} data-route={guidance.route ?? "main"} data-route-phase={guidance.phase}>
        <span className="route-status-name">{id === "red" ? "SCARLET" : "COBALT"}</span>
        <strong><span aria-hidden="true">{guidance.route === "left" ? "↖" : guidance.route === "right" ? "↗" : "↑"}</span> {guidance.instruction}</strong>
        <small>{guidance.junctionNumber ? `分岐${guidance.junctionNumber} · ` : ""}{guidance.selection}{!compact && guidance.phase !== "complete" ? ` · ${guidance.phase === "branch" ? "合流" : "入口"}まで ${guidance.distance.toFixed(0)} u` : ""}</small>
        {!compact && <span className="route-status-road">現在：{guidance.currentRoad}</span>}
      </div>;
    })}
  </div>;
}
