"use client";

import { useMemo } from "react";
import { circuitPosition } from "../lib/circuit-geometry";
import { COURSE_NAMES, roadKey } from "../lib/race-course";
import { routeGuidance } from "../lib/route-guidance";
import { RaceRouteStatus } from "./race-route-status";
import type { CourseFeatures, RouteChoice } from "../lib/race-course";
import { getObstacleAsset } from "../lib/obstacle-catalog";
import { raceEffectsAt, type RaceEffectState } from "../lib/race-effects";
import "./race-tactics.css";

type Id = "red" | "blue";
type Driver = RaceEffectState & { progress: number; lane: number; targetLane: number; speed: number; routeChoices?: Record<string, RouteChoice>; carCollisions?: number; lastCarCollisionAt?: number; upcomingObstacles: { id: string; progress: number; blockedLane: number; assetId?: string }[] };
export type TacticalRace = { carInteraction?: "solid" | "ghost"; paceRules?: { visibleDistance: number }; phase: string; updatedAt: number; now?: number; course: CourseFeatures & { length: number }; players: Record<Id, Driver> };
const names = { red: "SCARLET", blue: "COBALT" };
const colors = { red: "#ff625b", blue: "#68a4ff" };

export function CourseMap({ race, compact = false }: { race: TacticalRace; compact?: boolean }) {
  const map = useMemo(() => {
    type MapPath = { key: string; points: ReturnType<typeof circuitPosition>[]; route?: RouteChoice; junctionId?: string };
    const paths: MapPath[] = [];
    const sample = (start: number, end: number, choices: Record<string, RouteChoice> = {}) => Array.from({ length: 121 }, (_, i) => circuitPosition(start + (end - start) * i / 120, 1, race.course.length, race.course, choices));
    let cursor = 0;
    for (const junction of race.course.junctions || []) {
      paths.push({ key: `main-${cursor}`, points: sample(cursor, junction.start) });
      for (const route of ["left", "right"] as const) paths.push({ key: `${junction.id}-${route}`, points: sample(junction.start, junction.end, { [junction.id]: route }), route, junctionId: junction.id });
      cursor = junction.end;
    }
    paths.push({ key: "finish", points: sample(cursor, race.course.length) });
    const all = paths.flatMap(p => p.points);
    const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
    const minZ = Math.min(...all.map(p => p.z)), maxZ = Math.max(...all.map(p => p.z));
    const scale = Math.min(745 / (maxX - minX + 1), 310 / (maxZ - minZ + 1));
    const project = (p: { x: number; z: number }) => ({ x: 430 + (p.x - (minX + maxX) / 2) * scale, y: 218 + (p.z - (minZ + maxZ) / 2) * scale });
    // Repaint bridge spans above their outlined deck. A crossing is not a junction.
    const elevated: MapPath[] = [];
    for (const path of paths) {
      let run: MapPath["points"] = [];
      for (const point of path.points) {
        if (point.y > 6) run.push(point);
        else if (run.length) { if (run.length > 1) elevated.push({ ...path, key: `${path.key}-bridge-${elevated.length}`, points: run }); run = []; }
      }
      if (run.length > 1) elevated.push({ ...path, key: `${path.key}-bridge-${elevated.length}`, points: run });
    }
    return { paths, elevated, project };
  }, [race.course]);
  const guidance = { red: routeGuidance(race.course, race.players.red), blue: routeGuidance(race.course, race.players.blue) };
  const drawPath = (path: (typeof map.paths)[number]) => {
    const d = path.points.map((point, i) => { const q = map.project(point); return `${i ? "L" : "M"}${q.x.toFixed(2)},${q.y.toFixed(2)}`; }).join(" ");
    return <g key={path.key}><path d={d} fill="none" stroke="#102129" strokeWidth="27" strokeLinecap="round" /><path d={d} fill="none" stroke={path.route === "left" ? "#688bb3" : path.route === "right" ? "#a7955e" : "#516770"} strokeWidth="20" strokeLinecap="round" />
      {(["red", "blue"] as Id[]).filter(id => path.route != null && guidance[id].junction?.id === path.junctionId && guidance[id].route === path.route).map(id => <path key={id} d={d} fill="none" stroke={colors[id]} strokeWidth={id === "red" ? 7 : 4} strokeDasharray={id === "blue" ? "10 5" : undefined} opacity=".95" />)}
    </g>;
  };
  return <div className={`course-map-panel${compact ? " is-compact" : ""}`}><svg className={`tactical-map ${compact ? "compact" : ""}`} viewBox="0 0 860 450" role="img" aria-label="分岐の左道と右道、赤と青の選択進路と現在位置。中央の立体交差では曲がれません。">
    <rect width="860" height="450" rx="12" fill="#102129" />
    <text x="26" y="34" fill="#d8ed94" fontSize="17" letterSpacing="3">{race.course.layout ? COURSE_NAMES[race.course.layout] : "TOKYO CIRCUIT"}</text>
    {map.paths.map(drawPath)}{map.elevated.map(drawPath)}
    {map.paths.filter(path => path.route).map(path => {
      const mid = path.points[60], p = map.project(mid), ahead = map.project(path.points[64]);
      const heading = Math.atan2(ahead.y - p.y, ahead.x - p.x) * 180 / Math.PI;
      const index = (race.course.junctions?.findIndex(j => j.id === path.junctionId) ?? 0) + 1;
      return <g key={`${path.key}-direction`}><path d="M-8 -7L4 0L-8 7" fill="none" stroke="#f5f8ed" strokeWidth="3" transform={`translate(${p.x} ${p.y}) rotate(${heading})`} /><text x={p.x} y={p.y + (path.route === "left" ? -16 : 27)} textAnchor="middle" fontSize="15" fontWeight="bold" fill="#f2f6e8" stroke="#102129" strokeWidth="5" paintOrder="stroke">{index} {path.route === "left" ? "左" : "右"}</text></g>;
    })}
    {(race.course.junctions || []).map((junction, index) => { const p = map.project(circuitPosition(junction.start, 1, race.course.length, race.course)); return <g key={junction.id}><circle cx={p.x} cy={p.y} r="15" fill="#d8ed94" /><text x={p.x} y={p.y + 5} textAnchor="middle" fontSize="17" fontWeight="bold" fill="#15251e">{index + 1}</text></g>; })}
    {(["red", "blue"] as Id[]).map(id => { const driver = race.players[id]; const point = circuitPosition(driver.progress, driver.lane, race.course.length, race.course, driver.routeChoices); const p = map.project(point); return <g key={id}><circle cx={p.x} cy={p.y} r="10" fill={colors[id]} stroke="#fff" strokeWidth="3" /><text x={p.x} y={p.y + (id === "red" ? -21 : 32)} textAnchor="middle" fontWeight="bold" fontSize="15" fill={colors[id]} stroke="#102129" strokeWidth="4" paintOrder="stroke">{names[id]}</text></g>; })}
    <text x="26" y="424" fill="#b4c6cc" fontSize="15">①② 分岐 · 矢印は進行方向 · 中央は立体交差（接続なし）</text>
  </svg><RaceRouteStatus race={race} compact /></div>;
}

export function RivalRadar({ race, player }: { race: TacticalRace; player: Id }) {
  const other = player === "red" ? "blue" : "red";
  const mine = race.players[player], rival = race.players[other];
  const gap = rival.progress - mine.progress;
  const sameRoad = roadKey(race.course, mine) === roadKey(race.course, rival);
  const ghost = race.carInteraction === "ghost";
  const danger = !ghost && sameRoad && Math.abs(gap) < 9 && Math.abs(rival.lane - mine.lane) < 0.85;
  const collision = !ghost && mine.lastCarCollisionAt != null && (race.now ?? race.updatedAt) - mine.lastCarCollisionAt < 1600;
  return <div className={`rival-radar ${danger ? "danger" : ""}`} role="status">
    <span className="rival-dot" style={{ background: colors[other] }} />
    <div><strong>{names[other]} · {sameRoad ? gap >= 0 ? "前方" : "後方" : "別の区間 / 分岐"} {Math.abs(gap).toFixed(1)} u</strong>
      <span>{ghost ? "相手とはすり抜け · コース上の障害物だけを回避" : collision ? "車両に接触 · 両車が減速中" : danger ? "接近注意 · 減速か車線変更で回避" : sameRoad ? `${["左", "中央", "右"][Math.round(rival.lane)]}レーン · 相手の車も衝突対象です` : "合流時は相手の位置を確認"}</span></div>
    <b>{ghost ? "GHOST" : `CONTACTS ${mine.carCollisions ?? 0}`}</b>
  </div>;
}

export function RouteControls({ race, player, enabled, onChoose }: { race: TacticalRace; player: Id; enabled: boolean; onChoose: (junctionId: string, route: RouteChoice) => void }) {
  const guidance = routeGuidance(race.course, race.players[player]);
  const junction = guidance.junction;
  if (!race.course.junctions?.length) return null;
  if (!junction) return <div className="route-clear">本道を直進 · すべての分岐を通過</div>;
  return <section className="route-controls" aria-label="分岐の進路選択（車線選択とは別）" data-route-phase={guidance.phase}>
    <div className="route-title"><span>ROUTE {String(guidance.junctionNumber).padStart(2, "0")} / {junction.name}</span><b>{guidance.phase === "branch" ? `合流まで ${guidance.distance.toFixed(0)} u` : `入口まで ${guidance.distance.toFixed(0)} u`}</b></div>
    <div className="route-current"><strong>{guidance.route === "left" ? "↖" : "↗"} {guidance.instruction}</strong><span>{guidance.selection}</span><small>現在：{guidance.currentRoad}</small></div>
    <div className="route-buttons">{(["left", "right"] as const).map(route => { const info = junction.routes[route]; return <button type="button" key={route} aria-label={`分岐を${route === "left" ? "左" : "右"}へ進む / ROUTE ${route.toUpperCase()}`} aria-pressed={guidance.route === route} disabled={!enabled || guidance.locked} onClick={() => onChoose(junction.id, route)}>
      <strong>{route === "left" ? "↖ 左へ進む" : "右へ進む ↗"}</strong><span>ROUTE {route.toUpperCase()} · {info.name}</span><span>{info.description} / 速度 ×{info.speedMultiplier.toFixed(2)}</span><small>{guidance.route === route ? guidance.selection : guidance.locked ? "この道は選択できません" : "この分岐を選ぶ"}</small>
    </button>; })}</div><p className="route-lane-note">分岐は道路の選択です。車線は下の LANE で変更します。</p>
  </section>;
}

export function TacticalRoad({ race, player }: { race: TacticalRace; player: Id }) {
  const mine = race.players[player], other = player === "red" ? "blue" : "red", rival = race.players[other];
  const gap = rival.progress - mine.progress;
  const sameRoad = roadKey(race.course, mine) === roadKey(race.course, rival);
  const guidance = routeGuidance(race.course, mine);
  const visibleDistance = race.paceRules?.visibleDistance ?? 60;
  const ghost = race.carInteraction === "ghost";
  // Enlarge the near field so the two cars remain distinguishable at bumper distance.
  const depth = (distance: number) => Math.sign(distance) * (Math.abs(distance) <= 6 ? Math.abs(distance) * 22 : 132 + (Math.abs(distance) - 6) * (2.1 * 54 / (visibleDistance - 6)));
  const now = race.now ?? race.updatedAt;
  const car = (id: Id, lane: number, y: number, own: boolean) => {
    const effect = raceEffectsAt(race.players[id], now, race.phase);
    return <g transform={`translate(${100 + lane * 110} ${y})`} data-effect={effect.spinning ? "spin" : effect.airborne ? "jump" : "ground"}>
      {effect.airborne && <><ellipse rx="22" ry="31" fill="#07131e" opacity=".5" /><path d="M-14 18l-8 18M0 21v25M14 18l8 18" stroke="#a7f4ff" strokeWidth="4" /></>}
      <g opacity={ghost && !own ? 0.45 : 1} transform={`translate(0 ${-effect.height * 7}) rotate(${effect.spinRadians * 180 / Math.PI}) scale(${1 + effect.height * .035})`}>
        <rect x="-18" y="-29" width="36" height="58" rx="8" fill={colors[id]} stroke="#eff6ff" strokeWidth={own ? 2 : 3} strokeDasharray={ghost && !own ? "5 3" : undefined} /><rect x="-12" y="-7" width="24" height="18" rx="3" fill="#11242f" /><path d="M-21 -19V-8M21 -19V-8M-21 14V24M21 14V24" stroke="#08131d" strokeWidth="6" />
      </g>
      <text x="0" y={own ? 49 : -39 - effect.height * 7} fill={colors[id]} fontSize="13" fontWeight="bold" textAnchor="middle">{own ? `YOU / ${names[id]}` : `${names[id]}${ghost ? " / すり抜け" : ""}`}</text>
      {(effect.airborne || effect.spinning) && <text x="0" y={own ? 68 : -58 - effect.height * 7} fill={effect.spinning ? "#ffe274" : "#a7f4ff"} fontSize="13" fontWeight="bold" textAnchor="middle">{effect.spinning ? `SPIN ${(effect.spinRemainingMs / 1000).toFixed(1)}s · 停止中` : `AIR ${(effect.jumpRemainingMs / 1000).toFixed(1)}s`}</text>}
    </g>;
  };
  return <svg className="road-preview tactical-road" viewBox="0 0 420 440" role="img" aria-label={`前方${visibleDistance}ユニットと後方4ユニット。自車と${sameRoad ? "相手車両" : "別ルートの相手は非表示"}、障害物を表示。${ghost ? "相手車両はすり抜け可能" : "相手車両も衝突対象"}`}>
    <defs><pattern id={`lane-dashes-${player}`} x="0" y={(mine.progress * 4.2) % 40} width="110" height="40" patternUnits="userSpaceOnUse"><path d="M45 0V20" stroke="#8d9da4" strokeWidth="2" /></pattern></defs>
    <rect width="420" height="440" rx="12" fill="#11212b" /><path d="M45 45H375V424H45Z" fill="#2c3d48" />
    <rect x="150" y="45" width="120" height="375" fill={`url(#lane-dashes-${player})`} />
    <path d="M45 45V424M375 45V424" stroke="#d8ed94" strokeWidth="4" strokeDasharray="12 10" />
    <text x="210" y="25" textAnchor="middle" fill="#d8ed94" fontSize="12" fontWeight="bold">{guidance.phase === "branch" ? `分岐${guidance.junctionNumber} · ${guidance.direction}ルート走行中（確定）` : guidance.junction ? `本道 → 分岐${guidance.junctionNumber}で${guidance.direction}へ / ${guidance.explicitChoice ? "選択済み" : "既定"}` : "本道 · すべての分岐を通過"}</text>
    {ghost && sameRoad && gap >= -4 && gap <= visibleDistance && car(other, rival.lane, 318 - depth(gap), false)}
    {mine.upcomingObstacles.map(o => { const distance = o.progress - mine.progress; if (distance < -2 || distance > visibleDistance) return null; const asset = getObstacleAsset(o.assetId); return <g key={o.id} transform={`translate(${100 + o.blockedLane * 110} ${318 - depth(distance)})`}>
      {asset ? <image href={asset.topUrl} x="-31" y="-31" width="62" height="62"><title>{asset.label}</title></image> : <><rect x="-40" y="-11" width="80" height="22" rx="3" fill="#f2bd54" /><path d="M-30 -10L-10 10M-5 -10L15 10M20 -10L40 10" stroke="#695024" strokeWidth="7" /></>}
      <text x="0" y={asset ? -35 : -19} textAnchor="middle" fill="#ffe0a1" fontSize="12">{asset ? `${asset.label} · ` : ""}{distance.toFixed(0)} u</text>
    </g>; })}
    {!ghost && sameRoad && gap >= -4 && gap <= visibleDistance && car(other, rival.lane, 318 - depth(gap), false)}
    {car(player, mine.lane, 318, true)}
    <text x="100" y="410" textAnchor="middle" fill="#c0d0d5" fontSize="11">左車線</text><text x="210" y="410" textAnchor="middle" fill="#c0d0d5" fontSize="11">中央車線</text><text x="320" y="410" textAnchor="middle" fill="#c0d0d5" fontSize="11">右車線</text><text x="210" y="431" textAnchor="middle" fill="#b8c9d2" fontSize="11">FRONT {visibleDistance} u / REAR 4 u · {ghost ? "車両はすり抜け可能" : "車両同士も衝突します"}</text>
  </svg>;
}
