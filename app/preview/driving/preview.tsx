"use client";

import { useEffect, useRef, useState } from "react";
import "./styles.css";

type Lane = "LEFT" | "CENTER" | "RIGHT";
type Speed = "SLOW" | "NORMAL" | "TURBO";
type Route = "LEFT" | "RIGHT";
type Entry = { id: number; label: string; atMs: number };
type Controls = { lane: Lane; speed: Speed; route: Route; ready: boolean; jumps: number };

export function DrivingPreview() {
  const openedAt = useRef(0);
  const sequence = useRef(0);
  const [controls, setControls] = useState<Controls>({ lane: "CENTER", speed: "NORMAL", route: "RIGHT", ready: false, jumps: 0 });
  const [history, setHistory] = useState<Entry[]>([]);
  useEffect(() => { openedAt.current = performance.now(); }, []);

  function accept(label: string, update: Partial<Controls>) {
    const entry = { id: ++sequence.current, label, atMs: Math.max(0, performance.now() - openedAt.current) };
    setControls(previous => ({ ...previous, ...update }));
    setHistory(previous => [entry, ...previous]);
  }

  const last = history[0];
  return <main className="driving-preview">
    <header className="driving-preview-header">
      <div><p>AGENTRACER / COMPUTER USE FIXTURE</p><h1>2D DRIVER COCKPIT</h1></div>
      <strong>操作検証用・実レースではありません</strong>
    </header>
    <p className="driving-preview-note">このページ内だけで操作を記録します。API・認証・実レースへの通信はありません。ボタンは待ち時間なしで何度でも押せます。</p>
    <div className="driving-preview-grid">
      <section className="driving-preview-road" aria-label="固定サンプルの走行画面">
        <div className="driving-preview-section-title"><b>YOU ARE SCARLET</b><span>FRONT VIEW · 60 UNITS AHEAD</span></div>
        <div className="driving-preview-track">
          {(["LEFT", "CENTER", "RIGHT"] as Lane[]).map((lane, index) => <div className="driving-preview-lane" key={lane}>
            <b>{lane}</b>
            <span className="driving-preview-obstacle" style={{ top: `${[28, 53, 13][index]}%` }}>障害物<br />{[32, 15, 50][index]} u</span>
            {lane === "RIGHT" && <span className="driving-preview-rival">COBALT<br />+9 u</span>}
            {controls.lane === lane && <span className="driving-preview-car">SCARLET</span>}
          </div>)}
        </div>
        <p className="driving-preview-warning">NEXT OBSTACLE: <b>CENTER · 15 UNITS AHEAD</b></p>
        <p className="driving-preview-warning">RIVAL: <b>COBALT · RIGHT LANE · 9 UNITS AHEAD</b></p>
        <div className="driving-preview-readout" aria-live="polite">
          <span>LANE <b>{controls.lane}</b></span><span>SPEED <b>{controls.speed}</b></span>
          <span>ROUTE <b>{controls.route}</b></span><span>JUMPS <b>{controls.jumps}</b></span>
        </div>
      </section>
      <section className="driving-preview-controls" aria-label="ドライバー操作">
        <div className="driving-preview-ready"><div><b>01 / JOIN THE GRID</b><p>{controls.ready ? "READY ACCEPTED / 準備完了" : "READYを押して操作を確認"}</p></div><button type="button" aria-pressed={controls.ready} onClick={() => accept("READY", { ready: true })}>READY</button></div>
        <fieldset><legend>ROUTE / 分岐を選ぶ（車線とは別）</legend><div className="driving-preview-buttons driving-preview-routes">
          {(["LEFT", "RIGHT"] as Route[]).map(route => <button type="button" key={route} aria-pressed={controls.route === route} onClick={() => accept(`ROUTE ${route}`, { route })}><b>ROUTE {route}</b><small>{route === "LEFT" ? "↖ 左へ進む" : "右へ進む ↗"}</small></button>)}
        </div></fieldset>
        <fieldset><legend>02 / CHOOSE YOUR LANE · 今の道路内</legend><div className="driving-preview-buttons">
          {(["LEFT", "CENTER", "RIGHT"] as Lane[]).map((lane, index) => <button type="button" key={lane} aria-pressed={controls.lane === lane} onClick={() => accept(`LANE ${lane}`, { lane })}><b>{lane}</b><small>{["左レーン", "中央レーン", "右レーン"][index]}</small></button>)}
        </div></fieldset>
        <fieldset><legend>03 / SET YOUR SPEED</legend><div className="driving-preview-buttons">
          {(["SLOW", "NORMAL", "TURBO"] as Speed[]).map(speed => <button type="button" key={speed} aria-pressed={controls.speed === speed} onClick={() => accept(`SPEED ${speed}`, { speed })}>{speed}</button>)}
        </div></fieldset>
        <div className="driving-preview-ready"><div><b>04 / AIR JUMP</b><p>検証用：クールダウンなし</p></div><button type="button" onClick={() => accept("JUMP", { jumps: controls.jumps + 1 })}>JUMP</button></div>
      </section>
    </div>
    <section className="driving-preview-history" aria-label="受理した操作履歴">
      <div className="driving-preview-section-title" aria-live="polite"><b>ACCEPTED COUNT: <output>{last?.id ?? 0}</output></b><span>LAST ACTION: <output>{last ? `${last.label} · +${last.atMs.toFixed(1)} ms` : "NONE"}</output></span></div>
      <div className="driving-preview-log">
        {history.length ? <ol>{history.map(entry => <li key={entry.id}><b>#{entry.id}</b><span>{entry.label}</span><time>+{entry.atMs.toFixed(1)} ms</time><span>ACCEPTED</span></li>)}</ol> : <p>ボタンを押すと、操作とページ表示からの経過時間がここに表示されます。</p>}
      </div>
    </section>
  </main>;
}
