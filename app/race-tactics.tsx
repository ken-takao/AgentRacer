"use client";

import { useMemo } from "react";
import { circuitPosition } from "../lib/circuit-geometry";
import { COURSE_NAMES, activeJunction, nextJunction, roadKey, selectedRoute } from "../lib/race-course";
import type { CourseFeatures, RouteChoice } from "../lib/race-course";
import { getObstacleAsset } from "../lib/obstacle-catalog";
import { raceEffectsAt, type RaceEffectState } from "../lib/race-effects";
import "./race-tactics.css";

type Id = "red" | "blue";
type Driver = RaceEffectState & { progress: number; lane: number; targetLane: number; speed: number; routeChoices?: Record<string, RouteChoice>; carCollisions?: number; lastCarCollisionAt?: number; upcomingObstacles: { id: string; progress: number; blockedLane: number; assetId?: string }[] };
export type TacticalRace = { phase: string; updatedAt: number; now?: number; course: CourseFeatures & { length: number }; players: Record<Id, Driver> };
const names = { red: "SCARLET", blue: "COBALT" };
const colors = { red: "#ff625b", blue: "#68a4ff" };

export function CourseMap({ race, compact = false }: { race: TacticalRace; compact?: boolean }) {
  const map = useMemo(() => {
    const paths: { key: string; points: ReturnType<typeof circuitPosition>[] }[] = [];
    const sample = (start: number, end: number, choices: Record<string, RouteChoice> = {}) => Array.from({ length: 121 }, (_, i) => circuitPosition(start + (end - start) * i / 120, 1, race.course.length, race.course, choices));
    let cursor = 0;
    for (const junction of race.course.junctions || []) {
      paths.push({ key: `main-${cursor}`, points: sample(cursor, junction.start) });
      for (const route of ["left", "right"] as const) paths.push({ key: `${junction.id}-${route}`, points: sample(junction.start, junction.end, { [junction.id]: route }) });
      cursor = junction.end;
    }
    paths.push({ key: "finish", points: sample(cursor, race.course.length) });
    const all = paths.flatMap(p => p.points);
    const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
    const minZ = Math.min(...all.map(p => p.z)), maxZ = Math.max(...all.map(p => p.z));
    const scale = Math.min(760 / (maxX - minX + 1), 330 / (maxZ - minZ + 1));
    const project = (p: { x: number; z: number }) => ({ x: 430 + (p.x - (minX + maxX) / 2) * scale, y: 224 + (p.z - (minZ + maxZ) / 2) * scale });
    return { paths, project };
  }, [race.course]);
  return <svg className={`tactical-map ${compact ? "compact" : ""}`} viewBox="0 0 860 450" role="img" aria-label="分岐と立体交差を含むコース全体図。赤と青の現在位置">
    <rect width="860" height="450" rx="12" fill="#102129" />
    <text x="26" y="34" fill="#d8ed94" fontSize="17" letterSpacing="3">{race.course.layout ? COURSE_NAMES[race.course.layout] : "TOKYO CIRCUIT"}</text>
    {map.paths.map(path => <path key={path.key} d={path.points.map((p, i) => { const q = map.project(p); return `${i ? "L" : "M"}${q.x.toFixed(2)},${q.y.toFixed(2)}`; }).join(" ")} fill="none" stroke={path.key.includes("left") ? "#688bb3" : path.key.includes("right") ? "#a7955e" : "#516770"} strokeWidth="21" strokeLinecap="round" />)}
    {(race.course.junctions || []).map((junction, index) => { const p = map.project(circuitPosition(junction.start, 1, race.course.length, race.course)); return <g key={junction.id}><circle cx={p.x} cy={p.y} r="17" fill="#d8ed94" /><text x={p.x} y={p.y + 6} textAnchor="middle" fontSize="18" fontWeight="bold" fill="#15251e">{index + 1}</text></g>; })}
    {(["red", "blue"] as Id[]).map(id => { const d = race.players[id]; const p = map.project(circuitPosition(d.progress, d.lane, race.course.length, race.course, d.routeChoices)); return <g key={id}><circle cx={p.x} cy={p.y} r="12" fill={colors[id]} stroke="#fff" strokeWidth="3" /><text x={p.x} y={p.y + (id === "red" ? -21 : 34)} textAnchor="middle" fontWeight="bold" fontSize="17" fill={colors[id]}>{names[id]}</text></g>; })}
    <text x="26" y="431" fill="#b4c6cc" fontSize="15">①② ROUTE CHOICE · CROSSING = OVERPASS</text>
  </svg>;
}

export function RivalRadar({ race, player }: { race: TacticalRace; player: Id }) {
  const other = player === "red" ? "blue" : "red";
  const mine = race.players[player], rival = race.players[other];
  const gap = rival.progress - mine.progress;
  const sameRoad = roadKey(race.course, mine) === roadKey(race.course, rival);
  const danger = sameRoad && Math.abs(gap) < 9 && Math.abs(rival.lane - mine.lane) < 0.85;
  const collision = mine.lastCarCollisionAt != null && (race.now ?? race.updatedAt) - mine.lastCarCollisionAt < 1600;
  return <div className={`rival-radar ${danger ? "danger" : ""}`} role="status">
    <span className="rival-dot" style={{ background: colors[other] }} />
    <div><strong>{names[other]} · {sameRoad ? gap >= 0 ? "前方" : "後方" : "別の区間 / 分岐"} {Math.abs(gap).toFixed(1)} u</strong>
      <span>{collision ? "車両に接触 · 両車が減速中" : danger ? "接近注意 · 減速か車線変更で回避" : sameRoad ? `${["左", "中央", "右"][Math.round(rival.lane)]}レーン · 相手の車も衝突対象です` : "合流時は相手の位置を確認"}</span></div>
    <b>CONTACTS {mine.carCollisions ?? 0}</b>
  </div>;
}

export function RouteControls({ race, player, enabled, onChoose }: { race: TacticalRace; player: Id; enabled: boolean; onChoose: (junctionId: string, route: RouteChoice) => void }) {
  const driver = race.players[player], junction = nextJunction(race.course, driver.progress);
  if (!race.course.junctions?.length) return null;
  if (!junction) return <div className="route-clear">ALL ROUTES CLEAR · ゴールまで車両と障害物に注意</div>;
  const locked = driver.progress >= junction.start;
  const choice = selectedRoute(junction, driver);
  return <section className="route-controls" aria-label="分岐の進路選択">
    <div className="route-title"><span>ROUTE {junction.id.endsWith("1") ? "01" : "02"} / {junction.name}</span><b>{locked ? "進路確定 / LOCKED" : `分岐まで ${Math.max(0, junction.start - driver.progress).toFixed(0)} u`}</b></div>
    <div className="route-buttons">{(["left", "right"] as const).map(route => { const info = junction.routes[route]; return <button type="button" key={route} aria-pressed={choice === route} disabled={!enabled || locked} onClick={() => onChoose(junction.id, route)}>
      <strong>{route === "left" ? "↖ LEFT" : "RIGHT ↗"} · {info.name}</strong><span>{info.description} / 速度 ×{info.speedMultiplier.toFixed(2)}</span><small>{choice === route ? locked ? "選択済み・この道を走行中" : "選択中・分岐に入る前は変更可能" : "この道を選ぶ"}</small>
    </button>; })}</div>
  </section>;
}

export function TacticalRoad({ race, player }: { race: TacticalRace; player: Id }) {
  const mine = race.players[player], other = player === "red" ? "blue" : "red", rival = race.players[other];
  const gap = rival.progress - mine.progress;
  const sameRoad = roadKey(race.course, mine) === roadKey(race.course, rival);
  const junction = activeJunction(race.course, mine.progress);
  // Enlarge the near field so the two cars remain distinguishable at bumper distance.
  const depth = (distance: number) => Math.sign(distance) * (Math.abs(distance) <= 6 ? Math.abs(distance) * 22 : 132 + (Math.abs(distance) - 6) * 2.1);
  const now = race.now ?? race.updatedAt;
  const car = (id: Id, lane: number, y: number, own: boolean) => {
    const effect = raceEffectsAt(race.players[id], now, race.phase);
    return <g transform={`translate(${100 + lane * 110} ${y})`} data-effect={effect.spinning ? "spin" : effect.airborne ? "jump" : "ground"}>
      {effect.airborne && <><ellipse rx="22" ry="31" fill="#07131e" opacity=".5" /><path d="M-14 18l-8 18M0 21v25M14 18l8 18" stroke="#a7f4ff" strokeWidth="4" /></>}
      <g transform={`translate(0 ${-effect.height * 7}) rotate(${effect.spinRadians * 180 / Math.PI}) scale(${1 + effect.height * .035})`}>
        <rect x="-18" y="-29" width="36" height="58" rx="8" fill={colors[id]} stroke="#eff6ff" strokeWidth={own ? 2 : 3} /><rect x="-12" y="-7" width="24" height="18" rx="3" fill="#11242f" /><path d="M-21 -19V-8M21 -19V-8M-21 14V24M21 14V24" stroke="#08131d" strokeWidth="6" />
      </g>
      <text x="0" y={own ? 49 : -39 - effect.height * 7} fill={colors[id]} fontSize="13" fontWeight="bold" textAnchor="middle">{own ? `YOU / ${names[id]}` : names[id]}</text>
      {(effect.airborne || effect.spinning) && <text x="0" y={own ? 68 : -58 - effect.height * 7} fill={effect.spinning ? "#ffe274" : "#a7f4ff"} fontSize="13" fontWeight="bold" textAnchor="middle">{effect.spinning ? `SPIN ${(effect.spinRemainingMs / 1000).toFixed(1)}s · 停止中` : `AIR ${(effect.jumpRemainingMs / 1000).toFixed(1)}s`}</text>}
    </g>;
  };
  return <svg className="road-preview tactical-road" viewBox="0 0 420 440" role="img" aria-label={`前方60ユニットと後方4ユニット。自車と${sameRoad ? "相手車両" : "別ルートの相手は非表示"}、障害物を表示`}>
    <defs><pattern id={`lane-dashes-${player}`} x="0" y={(mine.progress * 4.2) % 40} width="110" height="40" patternUnits="userSpaceOnUse"><path d="M45 0V20" stroke="#8d9da4" strokeWidth="2" /></pattern></defs>
    <rect width="420" height="440" rx="12" fill="#11212b" /><path d="M45 45H375V424H45Z" fill="#2c3d48" />
    <rect x="150" y="45" width="120" height="375" fill={`url(#lane-dashes-${player})`} />
    <path d="M45 45V424M375 45V424" stroke="#d8ed94" strokeWidth="4" strokeDasharray="12 10" />
    <text x="210" y="25" textAnchor="middle" fill="#d8ed94" fontSize="12" fontWeight="bold">{junction ? `${junction.name} / ${selectedRoute(junction, mine).toUpperCase()}` : "MAIN ROAD · LEFT / CENTER / RIGHT"}</text>
    {mine.upcomingObstacles.map(o => { const distance = o.progress - mine.progress; if (distance < -2 || distance > 60) return null; const asset = getObstacleAsset(o.assetId); return <g key={o.id} transform={`translate(${100 + o.blockedLane * 110} ${318 - depth(distance)})`}>
      {asset ? <image href={asset.topUrl} x="-31" y="-31" width="62" height="62"><title>{asset.label}</title></image> : <><rect x="-40" y="-11" width="80" height="22" rx="3" fill="#f2bd54" /><path d="M-30 -10L-10 10M-5 -10L15 10M20 -10L40 10" stroke="#695024" strokeWidth="7" /></>}
      <text x="0" y={asset ? -35 : -19} textAnchor="middle" fill="#ffe0a1" fontSize="12">{asset ? `${asset.label} · ` : ""}{distance.toFixed(0)} u</text>
    </g>; })}
    {sameRoad && gap >= -4 && gap <= 60 && car(other, rival.lane, 318 - depth(gap), false)}
    {car(player, mine.lane, 318, true)}
    <text x="210" y="431" textAnchor="middle" fill="#b8c9d2" fontSize="11">FRONT 60 u / REAR 4 u · 車両同士も衝突します</text>
  </svg>;
}
