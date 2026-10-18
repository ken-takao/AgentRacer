"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RaceCircuit3D } from "../../race-circuit-3d";
import { TacticalRoad, type TacticalRace } from "../../race-tactics";
import { createCourseFeatures } from "../../../lib/race-course";
import { OBSTACLE_ASSETS } from "../../../lib/obstacle-catalog";
import { raceEffectsAt } from "../../../lib/race-effects";
import "./styles.css";

type Prop = { id: string; assetId: string; progress: number; blockedLane: number };
type Preview = TacticalRace & { course: TacticalRace["course"] & { obstacles: Prop[] }; players: Record<"red" | "blue", TacticalRace["players"]["red"] & { slowedUntil: number }> };
function initial(): Preview {
  const player = (lane: number) => ({ progress: 5, lane, targetLane: lane, speed: 2.5, slowedUntil: 0, upcomingObstacles: [] });
  return { phase: "racing", updatedAt: 0, now: 0, course: { ...createCourseFeatures("effects-preview", 200), length: 200, obstacles: [] }, players: { red: player(0), blue: player(2) } };
}

/** Isolated visual fixture. It never creates races or calls a paid API. */
export function EffectsPreviewScreen() {
  const fixture = useRef(initial());
  const clock = useRef(0);
  const [frame, setFrame] = useState<Preview>(fixture.current);
  const [assetId, setAssetId] = useState("banana_peel");
  const sample = useCallback((timestamp: number) => {
    const previous = clock.current || timestamp;
    clock.current = timestamp;
    const state = fixture.current;
    for (const id of ["red", "blue"] as const) {
      const player = state.players[id];
      const stopped = Math.max(0, Math.min(timestamp, player.spinEndsAt ?? 0) - Math.max(previous, player.spinStartedAt ?? 0));
      player.progress = Math.min(190, player.progress + Math.max(0, timestamp - previous - stopped) * 0.0025);
      player.upcomingObstacles = state.course.obstacles.filter(o => o.progress >= player.progress - 1);
    }
    state.now = state.updatedAt = timestamp;
    return state;
  }, []);
  useEffect(() => {
    const timer = setInterval(() => { const current = sample(performance.now()); setFrame({ ...current, players: { red: { ...current.players.red }, blue: { ...current.players.blue } } }); }, 50);
    return () => clearInterval(timer);
  }, [sample]);
  const jump = () => {
    const state = sample(performance.now()), player = state.players.red;
    if ((player.jumpReadyAt ?? 0) > state.now!) return;
    player.jumpStartedAt = state.now; player.jumpEndsAt = state.now! + 800; player.jumpReadyAt = state.now! + 2800;
  };
  const spin = () => {
    const state = sample(performance.now()), player = state.players.blue;
    if ((player.spinEndsAt ?? 0) > state.now!) return;
    player.spinStartedAt = state.now; player.spinEndsAt = state.now! + 1200; player.spinProgress = player.progress; player.spinLane = player.lane;
  };
  const place = () => {
    const state = sample(performance.now());
    state.course = { ...state.course, obstacles: [...state.course.obstacles, { id: `preview-${state.course.obstacles.length}`, assetId, progress: Math.max(state.players.red.progress, state.players.blue.progress) + 8 + state.course.obstacles.length * 2, blockedLane: state.course.obstacles.length % 3 }] };
  };
  const redEffect = raceEffectsAt(frame.players.red, frame.now!), blueEffect = raceEffectsAt(frame.players.blue, frame.now!);
  return <main className="effects-preview">
    <header><div><small>AgentRacer / VISUAL FIXTURE</small><h1>ジャンプ・スピン・障害物</h1><p>表示確認用のデモです。実際のレース、サーバーの衝突判定、AI操作は実行しません。</p></div><a href="/">ホームへ</a></header>
    <div className="effects-preview-controls">
      <button onClick={jump} disabled={(frame.players.red.jumpReadyAt ?? 0) > frame.now!}>SCARLET JUMP {redEffect.airborne ? "空中" : (frame.players.red.jumpReadyAt ?? 0) > frame.now! ? `${((frame.players.red.jumpReadyAt! - frame.now!) / 1000).toFixed(1)}s` : "READY"}</button>
      <button onClick={spin} disabled={blueEffect.spinning}>COBALT SPIN {blueEffect.spinning ? `${(blueEffect.spinRemainingMs / 1000).toFixed(1)}s` : "1.2s"}</button>
      <select aria-label="プレビュー障害物" value={assetId} onChange={event => setAssetId(event.target.value)}>{OBSTACLE_ASSETS.map(asset => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select>
      <button onClick={place}>障害物を追加</button><span>追加済み {frame.course.obstacles.length}</span>
    </div>
    <section className="effects-preview-grid"><RaceCircuit3D race={frame} sampleRace={sample} /><aside><TacticalRoad race={frame} player="red" /><TacticalRoad race={frame} player="blue" /></aside></section>
  </main>;
}
