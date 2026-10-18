"use client";

import { useEffect, useMemo, useState } from "react";
import { RaceCircuit3D } from "../../race-circuit-3d";
import { CourseMap, RouteControls, TacticalRoad } from "../../race-tactics";
import { DEFAULT_FIXTURE, ROUTE_STAGES, readFixtureQuery, routeFixture, type FixtureOptions } from "./fixture";
import "./styles.css";

const stageNames = { before: "分岐の直前", entry: "入口", middle: "中間", premerge: "合流直前", exit: "出口", overpass: "立体交差・上", underpass: "立体交差・下" };
/** Deterministic visual inspection only: no network, race mutation or model calls. */
export function RoutesPreviewScreen() {
  const [options, setOptions] = useState<FixtureOptions>(DEFAULT_FIXTURE);
  useEffect(() => { setOptions(readFixtureQuery(new URLSearchParams(window.location.search))); }, []);
  const race = useMemo(() => routeFixture(options), [options]);
  const change = (patch: Partial<FixtureOptions>) => setOptions(current => {
    const next = { ...current, ...patch };
    const query = new URLSearchParams(Object.entries(next).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    return next;
  });
  return <main className="routes-preview">
    <header><div><small>AgentRacer / ROUTE INSPECTION</small><h1>分岐・路面の表示検証</h1><p>停止したサーバー形式のレース状態を表示します。速度・衝突判定や実際のレースは変更しません。</p></div><a href="/">ホーム</a></header>
    <section className="routes-preview-controls" aria-label="検証条件">
      <label>コース<select value={options.layout} onChange={event => change({ layout: event.target.value as FixtureOptions["layout"], progress: undefined })}>{["harbor", "alpine", "metro"].map(layout => <option key={layout}>{layout}</option>)}</select></label>
      <label>分岐<select value={options.junction} onChange={event => change({ junction: Number(event.target.value) as 1 | 2, progress: undefined })}><option value="1">01</option><option value="2">02</option></select></label>
      {(["red", "blue"] as const).map(id => <label key={id} className={`route-fixture-${id}`}>{id === "red" ? "SCARLET" : "COBALT"}<select value={options[id]} onChange={event => change({ [id]: event.target.value })}><option value="left">左へ進む</option><option value="right">右へ進む</option><option value="default">未操作・既定進路</option></select><select aria-label={`${id}の車線`} value={id === "red" ? options.redLane : options.blueLane} onChange={event => change({ [id === "red" ? "redLane" : "blueLane"]: Number(event.target.value) })}><option value="0">左車線</option><option value="1">中央車線</option><option value="2">右車線</option></select></label>)}
      <label>確認地点<select value={options.stage} onChange={event => change({ stage: event.target.value as FixtureOptions["stage"], progress: undefined })}>{ROUTE_STAGES.map(stage => <option value={stage} key={stage}>{stageNames[stage]}</option>)}</select></label>
      <label className="route-progress">距離 {race.players.red.progress.toFixed(2)} / 200<input aria-label="確認する距離" type="range" min="0" max="200" step="0.05" value={race.players.red.progress} onChange={event => change({ progress: Number(event.target.value) })} /></label>
    </section>
    <section className="routes-preview-grid"><RaceCircuit3D race={race} /><aside><CourseMap race={race} compact />{(["red", "blue"] as const).map(id => <section key={id}><h2 className={`route-fixture-${id}`}>{id === "red" ? "SCARLET" : "COBALT"}</h2><TacticalRoad race={race} player={id} /><RouteControls race={race} player={id} enabled onChoose={(_junction, route) => change({ [id]: route })} /></section>)}</aside></section>
  </main>;
}
