"use client";

import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./spectator-stage.css";
import { requestRaceJson, raceRetryDelay } from "../lib/race-api";
import { RacePreparation } from "./race-preparation";
import { RaceAudio } from "./race-audio";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleDot, Flag, Gauge, Maximize2, Monitor, Radio, Trophy, Zap } from "lucide-react";
const RaceCircuit3D = lazy(() => import("./race-circuit-3d").then(module => ({ default: module.RaceCircuit3D })));

type PlayerId = "red" | "blue";
type Speed = "slow" | "normal" | "turbo";
type Obstacle = { id: string; progress: number; blockedLane: 0 | 1 | 2 };
type Driver = {
  id: PlayerId; name: string; joined: boolean; ready: boolean; progress: number;
  lane: number; targetLane: 0 | 1 | 2; speedMode: Speed; speed: number;
  collisionCount: number; slowedUntil: number; upcomingObstacles: Obstacle[];
};
type Race = {
  phase: "lobby" | "countdown" | "racing" | "finished" | "cancelled";
  updatedAt: number; createdAt: number; countdownEndsAt: number | null; startedAt: number | null;
  finishedAt: number | null; winner: PlayerId | "tie" | null; remainingMs: number;
  players: Record<PlayerId, Driver>; course: { length: number; obstacles: Obstacle[] };
};
type Telemetry = { status: string; frameAt: number | null; actions: number; sessionId?: string };
type RaceResponse = { state: Race; telemetry: Record<PlayerId, Telemetry> };
type Input = { type: "join" | "ready" } | { type: "lane"; lane: 0 | 1 | 2 } | { type: "speed"; speed: Speed };
const COLORS = { red: "#ff5d58", blue: "#68a4ff" };
const NAMES = { red: "SCARLET", blue: "COBALT" };
const PHASE_LABELS = { lobby: "ドライバー接続待ち", countdown: "スタートまもなく", racing: "レース進行中", finished: "チェッカーフラッグ", cancelled: "レース中止" };
const enc = encodeURIComponent;

function Brand() {
  return <a className="brand" href="/" aria-label="Agent Grand Prix ホーム"><span className="brand-icon"><Flag size={21} fill="currentColor" /></span><span>AGENT<span className="brand-sub">GRAND PRIX</span></span></a>;
}
function SiteHeader({ live = false }: { live?: boolean }) {
  return <header className="site-header"><Brand /><div className="header-right"><span className="api-label">POWERED BY <strong>OPENAI AGENTS API</strong></span><span className={`live-pill ${live ? "is-live" : ""}`}><i />{live ? "LIVE RACE" : "COMPUTER USE"}</span></div></header>;
}
function isRaceResponse(value: unknown): value is RaceResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<RaceResponse>;
  const r = data.state;
  if (!r || !Object.hasOwn(PHASE_LABELS, r.phase) || !Number.isFinite(r.updatedAt) || !Number.isFinite(r.createdAt)
    || !r.course || !(r.course.length > 0) || !Array.isArray(r.course.obstacles) || !r.players
    || !data.telemetry || typeof data.telemetry !== "object") return false;
  return (["red", "blue"] as PlayerId[]).every(id => {
    const player = r.players[id];
    return player && [player.progress, player.lane, player.targetLane, player.speed, player.collisionCount].every(Number.isFinite)
      && Array.isArray(player.upcomingObstacles);
  });
}
function useRace(id: string, interval = 500) {
  const [data, setData] = useState<RaceResponse | null>(null);
  const [error, setError] = useState("");
  const [receivedAt, setReceivedAt] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion(v => v + 1), []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    let failures = 0;
    async function poll() {
      let failure: unknown;
      let nextInterval = interval;
      try {
        const json = await requestRaceJson<RaceResponse>(`/api/races/${enc(id)}`, { signal: abort.signal }, isRaceResponse);
        failures = 0;
        if (json.state.phase === "finished" || json.state.phase === "cancelled") nextInterval = 5000;
        if (!disposed) { setData(json); setReceivedAt(performance.now()); setError(""); }
      } catch (e) {
        failure = e; failures++;
        if (!disposed) setError(e instanceof Error ? e.message : "接続を確認しています");
      }
      if (!disposed) timer = setTimeout(poll, raceRetryDelay(failures, failure, nextInterval));
    }
    void poll();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); };
  }, [id, interval, retryVersion]);
  return { data, error, receivedAt, retry };
}

function useProjectedRace(race: Race | undefined, receivedAt: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const animate = (now: number) => {
      if (now - last > 32) { setTick(now); last = now; }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!race) return null;
  const elapsed = Math.max(0, Math.min((tick - receivedAt) / 1000, 1));
  const players = { ...race.players };
  for (const id of ["red", "blue"] as PlayerId[]) {
    const p = players[id];
    const laneDelta = p.targetLane - p.lane;
    players[id] = { ...p,
      progress: Math.min(race.course.length, p.progress + (race.phase === "racing" ? p.speed * elapsed : 0)),
      lane: p.lane + Math.sign(laneDelta) * Math.min(Math.abs(laneDelta), elapsed * 1.6),
    };
  }
  return { ...race, players, now: race.updatedAt + elapsed * 1000 };
}
function Car({ color, compact = false }: { color: PlayerId; compact?: boolean }) {
  return <g className={compact ? "car-compact" : ""}><rect x="-17" y="-15" width="8" height="11" rx="2" fill="#111519" /><rect x="9" y="-15" width="8" height="11" rx="2" fill="#111519" /><rect x="-17" y="6" width="8" height="12" rx="2" fill="#111519" /><rect x="9" y="6" width="8" height="12" rx="2" fill="#111519" /><rect x="-12" y="-26" width="24" height="53" rx="8" fill={COLORS[color]} /><path d="M-9 -22H9L7 -4H-7Z" fill="white" opacity=".2" /><path d="M-8 0H8L7 13H-7Z" fill="#131e2a" /><rect x="-3" y="-23" width="6" height="20" rx="2" fill="#fff5d9" /><rect x="-16" y="21" width="32" height="6" rx="2" fill={COLORS[color]} /><rect x="-15" y="-24" width="30" height="4" rx="1" fill="#fff5d9" /></g>;
}
// A three-lane capsule circuit. Distance maps directly to authoritative race progress.
function trackPoint(progress: number, lane: number, length: number) {
  const radius = 108 + (lane - 1) * 24;
  const straight = 420;
  const lap = 2 * straight + 2 * Math.PI * radius;
  const d = ((progress / length) % 1) * lap;
  if (d < straight) return { x: 220 + d, y: 244 - radius, angle: 90 };
  if (d < straight + Math.PI * radius) { const a = -Math.PI / 2 + (d - straight) / radius; return { x: 640 + Math.cos(a) * radius, y: 244 + Math.sin(a) * radius, angle: a * 180 / Math.PI + 180 }; }
  if (d < straight * 2 + Math.PI * radius) return { x: 640 - (d - straight - Math.PI * radius), y: 244 + radius, angle: 270 };
  const a = Math.PI / 2 + (d - straight * 2 - Math.PI * radius) / radius;
  return { x: 220 + Math.cos(a) * radius, y: 244 + Math.sin(a) * radius, angle: a * 180 / Math.PI + 180 };
}
function Circuit({ race, decorative = false }: { race?: Race | null; decorative?: boolean }) {
  const length = race?.course.length || 200;
  const positions = (["red", "blue"] as PlayerId[]).map((id, i) => {
    const driver = race?.players[id];
    return trackPoint(driver?.progress ?? (decorative ? 34 + i * 74 : 1), driver?.lane ?? i * 2, length);
  });
  const closeTogether = Math.hypot(positions[0].x - positions[1].x, positions[0].y - positions[1].y) < 36;
  const labelCenterX = (positions[0].x + positions[1].x) / 2;
  const labelY = Math.min(positions[0].y, positions[1].y) - 63;
  return <svg className={`circuit ${decorative ? "decorative-circuit" : ""}`} viewBox="0 0 860 475" role="img" aria-label="リアルタイムの3レーンレースコース。赤と青の車の位置を表示">
    <defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#ffffff" strokeOpacity=".035" /></pattern><pattern id="checker" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#e7e5d8" /><path d="M0 0H6V6H0ZM6 6H12V12H6Z" fill="#151c21" /></pattern><filter id="carShadow"><feDropShadow dx="0" dy="4" stdDeviation="5" floodOpacity=".55" /></filter></defs>
    <rect width="860" height="475" fill="url(#grid)" />
    <path d="M220 136H640A108 108 0 0 1 640 352H220A108 108 0 0 1 220 136" fill="none" stroke="#080e13" strokeWidth="109" />
    <path d="M220 136H640A108 108 0 0 1 640 352H220A108 108 0 0 1 220 136" fill="none" stroke="#bdc99b" strokeOpacity=".25" strokeWidth="99" strokeDasharray="10 10" />
    <path d="M220 136H640A108 108 0 0 1 640 352H220A108 108 0 0 1 220 136" fill="none" stroke="#2b343a" strokeWidth="88" />
    {[96, 120].map(r => <path key={r} d={`M220 ${244-r}H640A${r} ${r} 0 0 1 640 ${244+r}H220A${r} ${r} 0 0 1 220 ${244-r}`} fill="none" stroke="#778086" strokeOpacity=".48" strokeWidth="1.5" strokeDasharray="10 12" />)}
    <rect x="211" y="92" width="18" height="88" fill="url(#checker)" opacity=".85" /><text x="220" y="78" textAnchor="middle" fill="#a5afa8" fontSize="10" letterSpacing="2">START / FINISH</text>
    <path d="M367 65H487M480 59L487 65L480 71" stroke="#4a555b" fill="none" /><text x="430" y="235" textAnchor="middle" className="track-title">AGENT GRAND PRIX</text><text x="430" y="263" textAnchor="middle" className="track-subtitle">TWO AGENTS. ONE FINISH LINE.</text>
    {(race?.course.obstacles || []).map(o => { const p = trackPoint(o.progress, o.blockedLane, length); return <g key={o.id} transform={`translate(${p.x} ${p.y}) rotate(${p.angle})`}><rect x="-9" y="-5" width="18" height="10" rx="2" fill="#e9b65a" /><path d="M-6 -5L0 5M2 -5L8 5" stroke="#6a502c" strokeWidth="3" /></g>; })}
    {(["red", "blue"] as PlayerId[]).map((id, i) => {
      const p = positions[i];
      // Separate overlapping drawings sideways only; the dots retain the actual race positions.
      const offset = closeTogether ? (i === 0 ? -22 : 22) : 0;
      const radians = p.angle * Math.PI / 180;
      const dx = Math.cos(radians) * offset;
      const dy = Math.sin(radians) * offset;
      const badgeX = closeTogether ? labelCenterX + (i === 0 ? -37 : 37) - p.x - dx : 0;
      const badgeY = closeTogether ? labelY - p.y - dy : -42;
      return <g key={id}>
        {closeTogether && <g><line x1={p.x} y1={p.y} x2={p.x + dx} y2={p.y + dy} stroke={COLORS[id]} strokeWidth="1" strokeDasharray="2 2" opacity=".8" /><circle cx={p.x} cy={p.y} r="3" fill={COLORS[id]} stroke="#11191f" strokeWidth="1" /></g>}
        <g transform={`translate(${p.x + dx} ${p.y + dy})`}>
          <circle r="31" fill={COLORS[id]} opacity=".08" />
          <g transform={`rotate(${p.angle})`} filter="url(#carShadow)"><Car color={id} /></g>
          {closeTogether && <line x1="0" y1="-28" x2={badgeX} y2={badgeY + 9} stroke={COLORS[id]} strokeWidth="1" opacity=".45" />}
          <g transform={`translate(${badgeX} ${badgeY})`}><rect x="-29" y="-11" width="58" height="20" rx="5" fill="#11191f" stroke={COLORS[id]} strokeOpacity=".55" /><text textAnchor="middle" y="3" fontSize="10" fontWeight="700" fill={COLORS[id]}>{id.toUpperCase()}</text></g>
        </g>
      </g>;
    })}
    {closeTogether && <text x="430" y="420" textAnchor="middle" fill="#8a999e" fontSize="10">接近時は車体を横にずらして表示 · 点が実際の位置</text>}
    <text x="28" y="444" fill="#647077" fontSize="10" letterSpacing="2">TOKYO CIRCUIT</text><text x="832" y="444" textAnchor="end" fill="#647077" fontSize="10" letterSpacing="2">3 LANES · 200 UNITS</text>
  </svg>;
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function SpectatorCircuit({ race, decorative = false }: { race: Race & { now?: number }; decorative?: boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  const fail = useCallback(() => setUnavailable(true), []);
  const fallback = <div className="scene-fallback"><p role="status">3D表示を利用できないため、2Dでレースを表示しています。</p><Circuit race={race} decorative={decorative} /></div>;
  if (unavailable) return fallback;
  return <SceneBoundary fallback={fallback}><Suspense fallback={<div className="scene-loading" role="status"><span />3Dサーキットを準備しています</div>}><RaceCircuit3D race={race} decorative={decorative} onUnavailable={fail} /></Suspense></SceneBoundary>;
}
function previewRace(progress: number): Race & { now: number } {
  const driver = (id: PlayerId, offset: number, lane: number): Driver => ({ id, name: NAMES[id], joined: true, ready: true, progress: (progress + offset) % 200, lane, targetLane: lane as 0 | 1 | 2, speedMode: "normal", speed: 1.8, collisionCount: 0, slowedUntil: 0, upcomingObstacles: [] });
  return { phase: "racing", updatedAt: 0, createdAt: 0, countdownEndsAt: null, startedAt: 0, finishedAt: null, winner: null, remainingMs: 180000, now: progress * 1000, players: { red: driver("red", 0, 0), blue: driver("blue", 18, 2) }, course: { length: 200, obstacles: [25,50,75,100,125,150,175].map((p,i) => ({ id: `preview-${i}`, progress: p, blockedLane: (i % 3) as 0 | 1 | 2 })) } };
}

export function HomeScreen() {
  const [latest, setLatest] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [latestError, setLatestError] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function pollLatest() {
      let failed = false;
      try {
        const result = await requestRaceJson<{ id?: string }>("/api/races/latest", { signal: ac.signal });
        if (!disposed) {
          setLatest(result.id || null);
          setLatestError(false);
        }
      } catch { if (!disposed) setLatestError(true); failed = true; }
      if (!disposed) { setChecked(true); timer = setTimeout(pollLatest, failed ? 15000 : 3000); }
    }
    void pollLatest();
    return () => { disposed = true; ac.abort(); clearTimeout(timer); };
  }, []);
  return <><SiteHeader /><main className="home-main"><section className="home-hero"><div className="eyebrow"><span className="tiny-line" />THE COMPUTER USE RACING EXPERIMENT</div><h1>Two agents.<br /><span>One finish line.</span></h1><p className="home-description">画面を見る。ハンドルを切る。勝利を狙う。<br />2つのAIエージェントが、リアルタイムで競うレース。</p><div className="hero-actions">{latest ? <a className="button button-lime" href={`/race/${enc(latest)}`}><Radio size={18} />レースを観戦する<ArrowUpRight size={19} /></a> : <span className="button button-muted">{!checked ? "レースを確認中…" : latestError ? "レース情報を取得できません" : "開催中のレースはありません"}</span>}<a className="button button-lime" href="/preview/roadster">3Dプレビュー<ArrowUpRight size={17} /></a><a className="subtle-link" href="http://127.0.0.1:4180/">オペレーター画面<ArrowUpRight size={15} /></a></div><div className="hero-facts"><span><b>02</b> INDEPENDENT AGENTS</span><span><b>03</b> LANES</span><span><b>∞</b> POSSIBILITIES</span></div></section><section className="home-track"><div className="track-topline"><span><CircleDot size={13} />TOKYO CIRCUIT</span><span>REAL-TIME SIMULATION</span></div><SpectatorCircuit race={previewRace(30)} decorative /><div className="home-versus"><span className="red-text">01 / SCARLET</span><span>VS</span><span className="blue-text">02 / COBALT</span></div></section><section className="how-it-works"><div><span className="step">01 / SEE</span><h2>それぞれの視点で</h2><p>独立したクラウドブラウザーで、コースと障害物を観察。</p></div><div><span className="step">02 / DECIDE</span><h2>操作を決める</h2><p>Computer Useがレーンと速度のボタンをクリック。</p></div><div><span className="step">03 / RACE</span><h2>時間は止まらない</h2><p>判断している間もレースは進行。先にゴールしたAIの勝利。</p></div></section><p className="operator-note">対戦の開始は、主催者のローカルオペレーター画面から。観戦はこのサイトで楽しめます。</p></main><Footer /></>;
}
export function RoadsterPreviewScreen() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const animate = (now: number) => {
      setProgress(((now - start) / 1000 * 8) % 200);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <><SiteHeader /><main className="spectator-main"><div className="race-heading"><div><div className="eyebrow">TESLA ROADSTER / MODEL PREVIEW</div><h1>Roadster <em>preview.</em></h1><p>3Dサーキットのデモ走行です。実際のAI対戦とは別のプレビューです。</p></div><a className="subtle-link" href="/">ホームに戻る<ArrowUpRight size={15} /></a></div><section className="track-panel"><div className="track-topline"><span><CircleDot size={13} />MODEL PREVIEW</span><span>RED · BLUE</span></div><SpectatorCircuit race={previewRace(progress)} /></section></main><Footer /></>;
}
function Footer() { return <footer className="site-footer"><span>AGENT GRAND PRIX</span><span>BUILT WITH OPENAI AGENTS API + COMPUTER USE</span><span>DEMO / 2026</span></footer>; }
function Progress({ race }: { race: Race }) {
  return <div className="progress-board">{(["red", "blue"] as PlayerId[]).map(id => <div className={`progress-row ${id}`} key={id}><b>{NAMES[id]}</b><div className="progress-rail"><div style={{ width: `${Math.min(100, race.players[id].progress / race.course.length * 100)}%`, background: COLORS[id] }} /><span className="finish-marker"><Flag size={12} /></span></div><strong>{Math.floor(race.players[id].progress / race.course.length * 100)}<small>%</small></strong></div>)}</div>;
}
function RaceOutcome({ race }: { race: Race }) {
  const winner = race.winner;
  return <div className="race-outcome"><Trophy size={23} /><div><span>{race.phase === "cancelled" ? "RACE STOPPED" : "RACE FINISHED"}</span><strong>{race.phase === "cancelled" ? "レースは中止されました" : winner === "tie" ? "DRAW — 両者引き分け" : winner ? `${NAMES[winner]} WINS` : "レース終了"}</strong></div><Flag size={27} /></div>;
}
function DriverCard({ id, driver, telemetry, phase }: { id: PlayerId; driver: Driver; telemetry?: Telemetry; phase: Race["phase"] }) {
  return <div className={`driver-card ${id}`}><div className="driver-avatar"><svg viewBox="-25 -32 50 64"><Car color={id} /></svg></div><div className="driver-identity"><span>AGENT {id === "red" ? "01" : "02"}</span><h2>{NAMES[id]}</h2><p>{phase === "finished" ? "FINISHED" : phase === "cancelled" ? "STOPPED" : phase === "racing" ? "RACING" : driver.ready ? "READY TO RACE" : driver.joined ? "CONNECTED" : "CONNECTING"}</p></div><div className="driver-metrics"><div><strong>{driver.speed.toFixed(1)}</strong><span>SPEED / U·S</span></div><div><strong>{driver.collisionCount.toString().padStart(2, "0")}</strong><span>COLLISIONS</span></div><div className="metric-actions"><strong>{telemetry?.actions || 0}</strong><span>CU ACTIONS</span></div></div></div>;
}
function CameraPanel({ raceId, id, telemetry }: { raceId: string; id: PlayerId; telemetry?: Telemetry }) {
  const [expanded, setExpanded] = useState(false);
  const src = telemetry?.frameAt ? `/api/races/${enc(raceId)}/frame/${id}?t=${telemetry.frameAt}` : null;
  return <section className={`camera-panel ${id} ${expanded ? "camera-expanded" : ""}`}><div className="camera-header"><span><Monitor size={15} /><b>{NAMES[id]}</b><small>AGENT VIEW</small></span><button aria-label={expanded ? "映像を縮小" : `${NAMES[id]}の映像を拡大`} onClick={() => setExpanded(!expanded)}><Maximize2 size={15} /></button></div><div className="camera-content">{src ? <img src={src} alt={`${NAMES[id]}のComputer Useセッションが取得した実際のブラウザー画面`} /> : <div className="camera-placeholder"><Monitor size={32} strokeWidth={1} /><p>エージェントの視点を待っています</p><span>実際のComputer Useスクリーンショットがここに届きます</span></div>}</div><div className="camera-footer"><span><i className={src ? "active" : ""} />{telemetry?.status || "WAITING FOR SESSION"}</span><span>{telemetry?.frameAt ? new Date(telemetry.frameAt).toLocaleTimeString("ja-JP", { hour12: false }) : "—"}</span></div></section>;
}
function LoadingRace({ error, onRetry }: { error: string; onRetry?: () => void }) { return <div className="loading-race"><Flag size={32} /><h1>{error ? "レースへの接続を確認中" : "サーキットを準備しています"}</h1><p role="status">{error || "2つのエージェントを迎える準備中…"}</p>{error && onRetry && <button className="button button-lime" type="button" onClick={onRetry}>再接続する</button>}<a href="/">ホームへ戻る</a></div>; }
function NextRacePanel({ id }: { id: string }) {
  const [nextId, setNextId] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const latest = await requestRaceJson<{ id?: string }>("/api/races/latest", { signal: abort.signal });
        if (!abort.signal.aborted) setNextId(latest.id && latest.id !== id ? latest.id : null);
      } catch { /* Keep the local restart link available while offline. */ }
      if (!abort.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id]);
  return <section className="next-race-panel" aria-label="次のレース">
    <div><span className="eyebrow">READY FOR ANOTHER RACE?</span><h2>もう一度、スタートラインへ。</h2><p>この試合は終了しました。新しいレースは2つの新しいセッションで始まります。</p></div>
    <div className="next-race-actions">
      {nextId && <a className="button button-lime" href={`/race/${enc(nextId)}`}><Radio size={17} />次のレースを観戦する<ArrowUpRight size={17} /></a>}
      <a className={nextId ? "button button-muted" : "button button-lime"} href="http://127.0.0.1:4180/" target="agent-grand-prix-operator" rel="noopener noreferrer">もう一度レースする<ArrowUpRight size={17} /></a>
      <small>主催者のMacで操作画面が開きます。終了した試合の結果は残ります。</small>
    </div>
  </section>;
}
export function SpectatorScreen({ id }: { id: string }) {
  const { data, error, receivedAt, retry } = useRace(id);
  const race = useProjectedRace(data?.state, receivedAt);
  const elapsed = race ? Math.max(0, ((race.finishedAt || race.now) - (race.startedAt || race.createdAt)) / 1000) : 0;
  const countdown = race?.countdownEndsAt ? Math.max(0, Math.ceil((race.countdownEndsAt - race.now) / 1000)) : 0;
  return <><SiteHeader live={race?.phase === "racing"} /><main className="spectator-main">{!race ? <LoadingRace error={error} onRetry={retry} /> : <><div className="race-heading"><div><div className="eyebrow">LIVE EXPERIMENT / TOKYO CIRCUIT</div><h1>{race.phase === "finished" || race.phase === "cancelled" ? <>Ready to <em>race again?</em></> : race.phase === "lobby" ? <>Preparing the <em>grid.</em></> : <>The race is <em>on.</em></>}</h1><p>2つのAI。2つのブラウザー。勝者はひとり。</p></div><div className="race-clock"><span>{race.phase === "lobby" ? "PREPARATION TIME" : race.phase === "countdown" ? "START IN" : "RACE TIME"}</span><strong>{race.phase === "countdown" ? countdown : <>{Math.floor(elapsed / 60).toString().padStart(2, "0")}<i>:</i>{Math.floor(elapsed % 60).toString().padStart(2, "0")}<small>.{Math.floor(elapsed % 1 * 10)}</small></>}</strong></div></div>{error && <div className="connection-banner" role="status">接続を回復しています · 最後に受信したレース状態を表示中</div>}{(race.phase === "finished" || race.phase === "cancelled") && <NextRacePanel id={id} />}<RaceAudio raceId={id} phase={race.phase} /><div className="race-dashboard"><section className="track-panel spectator-track"><div className="track-topline"><span><i className={`status-dot ${race.phase === "racing" ? "active" : ""}`} />{PHASE_LABELS[race.phase]}</span><span>3D LIVE · 200 UNITS · 3 LANES</span></div><div className="spectator-stage"><SpectatorCircuit race={race} />{race.phase === "countdown" && <div className="countdown-overlay"><span>GET READY</span><strong>{countdown || "GO"}</strong></div>}{race.phase === "lobby" && <RacePreparation createdAt={race.createdAt} serverNow={data!.state.updatedAt} receivedAt={receivedAt} players={race.players} />}{(race.phase === "finished" || race.phase === "cancelled") && <RaceOutcome race={race} />}</div><Progress race={race} /></section><aside className="race-sidebar"><div className="sidebar-label">THE DRIVERS <span>02</span></div><DriverCard id="red" driver={race.players.red} telemetry={data?.telemetry.red} phase={race.phase} /><div className="versus-divider"><span />VS<span /></div><DriverCard id="blue" driver={race.players.blue} telemetry={data?.telemetry.blue} phase={race.phase} /><div className="race-rules"><span><Zap size={15} />THINK FAST. DRIVE SMART.</span><p>AIの思考中も車は進み続けます。障害物をかわし、速度を選んでゴールへ。</p><div><i className="obstacle-key" />障害物に接触すると一時減速</div></div></aside></div><div className="section-heading"><div><span className="eyebrow">BEHIND THE WHEEL</span><h2>AIが見ている、本当の画面。</h2></div><span><Monitor size={14} />COMPUTER USE CAPTURES</span></div><div className="camera-grid"><CameraPanel raceId={id} id="red" telemetry={data?.telemetry.red} /><CameraPanel raceId={id} id="blue" telemetry={data?.telemetry.blue} /></div><div className="spectator-note"><CircleDot size={14} /><span>上の3Dコースと下の2D操作画面は、同じレースの位置・車線・速度を表示しています。下の映像は各エージェントが取得したスクリーンショットです。</span></div></>}</main><Footer /></>;
}

function RoadPreview({ race, player }: { race: Race; player: PlayerId }) {
  const driver = race.players[player];
  return <svg className="road-preview" viewBox="0 0 420 390" role="img" aria-label={`前方60ユニット。現在${["左", "中央", "右"][driver.targetLane]}レーン`}><defs><pattern id="road-lines" x="0" y={(driver.progress * 6) % 40} width="100" height="40" patternUnits="userSpaceOnUse"><path d="M0 0V20" stroke="#65727a" strokeWidth="2" /></pattern></defs><rect width="420" height="390" rx="12" fill="#111c24" />{[25, 395].map(x => <path key={x} d={`M${x} 0V390`} stroke="#a8bc89" strokeWidth="4" strokeDasharray="13 13" opacity=".65" />)}<rect x="60" y="0" width="300" height="390" fill="#26343f" /><rect x="160" y="0" width="200" height="390" fill="url(#road-lines)" /><path d="M60 0V390M360 0V390" stroke="#8d9a9a" strokeWidth="2" />{["LEFT", "CENTER", "RIGHT"].map((v, i) => <text key={v} x={110 + i * 100} y="24" textAnchor="middle" fill="#a8b4ba" fontSize="11" fontWeight="700" letterSpacing="1">{v}</text>)}{driver.upcomingObstacles.map(o => { const distance = o.progress - driver.progress; if (distance < -4 || distance > 60) return null; const y = 310 - distance / 60 * 270; return <g key={o.id} transform={`translate(${110 + o.blockedLane * 100} ${y})`}><rect x="-37" y="-13" width="74" height="26" rx="4" fill="#efb64c" /><path d="M-30 -13L-10 13M-5 -13L15 13M20 -13L40 13" stroke="#795622" strokeWidth="8" /><text x="0" y="-21" textAnchor="middle" fontSize="13" fontWeight="700" fill="#f5cf8e">{Math.max(0, distance).toFixed(0)} u</text></g>; })}<g transform={`translate(${110 + driver.lane * 100} 318) scale(1.25)`}><circle r="32" fill={COLORS[player]} opacity=".15" /><Car color={player} /></g><text x="210" y="378" textAnchor="middle" fill="#9caeb9" fontSize="10" letterSpacing="2">YOUR CAR / {NAMES[player]}</text></svg>;
}
export function DriverScreen({ id, player }: { id: string; player: PlayerId }) {
  const { data, error, receivedAt, retry } = useRace(id, 300);
  const race = useProjectedRace(data?.state, receivedAt);
  const token = useRef("");
  const [tokenReady, setTokenReady] = useState(false);
  const [inputError, setInputError] = useState("");
  const [sending, setSending] = useState(false);
  const sendInput = useCallback(async (input: Input) => {
    if (!token.current) { setInputError("参加用URLからこの画面を開いてください。"); return; }
    setSending(true);
    try {
      await requestRaceJson(`/api/races/${enc(id)}/input`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.current}` }, body: JSON.stringify({ player, input }) });
      setInputError("");
    } catch (e) { setInputError(e instanceof Error ? e.message : "操作を送信できませんでした"); }
    finally { setSending(false); }
  }, [id, player]);
  useEffect(() => {
    try { token.current = decodeURIComponent(window.location.hash.slice(1)); } catch { token.current = ""; }
    setTokenReady(Boolean(token.current));
    if (token.current) void sendInput({ type: "join" });
  }, [sendInput]);
  const driver = race?.players[player];
  const targetLane = driver?.targetLane ?? 1;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!tokenReady || race?.phase === "finished" || race?.phase === "cancelled") return;
      if (e.repeat || (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName))) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); void sendInput({ type: "lane", lane: Math.max(0, targetLane - 1) as 0 | 1 | 2 }); }
      if (e.key === "ArrowRight") { e.preventDefault(); void sendInput({ type: "lane", lane: Math.min(2, targetLane + 1) as 0 | 1 | 2 }); }
    }
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [sendInput, targetLane, tokenReady, race?.phase]);
  const next = driver?.upcomingObstacles.find(o => o.progress >= driver.progress);
  const countdown = race?.countdownEndsAt ? Math.max(0, Math.ceil((race.countdownEndsAt - race.now) / 1000)) : 0;
  return <div className={`driver-page ${player}`}><header className="cockpit-header"><Brand /><div><span className="driver-badge" style={{ color: COLORS[player] }}>YOU ARE {NAMES[player]}</span><span className="live-pill"><i />PLAYER {player === "red" ? "01" : "02"}</span></div></header><main className="cockpit-main">{!race || !driver ? <LoadingRace error={error} onRetry={retry} /> : <><div className="cockpit-title"><div><span className="eyebrow">REAL-TIME DRIVER COCKPIT</span><h1>{race.phase === "finished" ? "FINISHED" : race.phase === "cancelled" ? "RACE STOPPED" : race.phase === "countdown" ? `START IN ${countdown}` : race.phase === "racing" ? "RACE IN PROGRESS" : "READY TO RACE?"}</h1></div><div className="cockpit-distance"><strong>{driver.progress.toFixed(0)}<small> / {race.course.length}</small></strong><span>DISTANCE / UNITS</span></div></div>{(inputError || error || !tokenReady) && <div className="cockpit-error" role="alert">{inputError || error || "参加用URLが必要です。オペレーターから割り当てられたURLを開いてください。"}</div>}<div className="cockpit-grid"><section className="road-panel"><div className="road-heading"><span><CircleDot size={14} />FRONT VIEW</span><strong>60 UNITS AHEAD</strong></div><RoadPreview race={race} player={player} /><div className="obstacle-warning"><span className="obstacle-key" /><span>{next ? <>NEXT OBSTACLE: <b>{["LEFT", "CENTER", "RIGHT"][next.blockedLane]}</b> · {Math.max(0, next.progress - driver.progress).toFixed(0)} UNITS AHEAD</> : "CLEAR ROAD AHEAD"}</span></div></section><section className="controls-panel"><div className="ready-row"><div><span className="control-label">01 / JOIN THE GRID</span><p>{driver.ready ? "準備完了。両者READYで自動スタート。" : "READYを押してレースに参加。"}</p></div><button className={`ready-button ${driver.ready ? "is-ready" : ""}`} disabled={!tokenReady || !driver.joined || driver.ready || race.phase !== "lobby"} onClick={() => void sendInput({ type: "ready" })}>{driver.ready ? <><Check size={20} />READY</> : <>READY<Flag size={18} /></>}</button></div><div className="control-block"><div className="control-block-heading"><span className="control-label">02 / CHOOSE YOUR LANE</span><span>障害物のないレーンへ</span></div><div className="lane-buttons">{([0, 1, 2] as const).map((lane, i) => <button key={lane} aria-pressed={driver.targetLane === lane} disabled={!tokenReady || (race.phase === "finished" || race.phase === "cancelled")} className={driver.targetLane === lane ? "selected" : ""} onClick={() => void sendInput({ type: "lane", lane })}>{i === 0 ? <ArrowLeft size={24} /> : i === 1 ? <ArrowDown size={24} style={{ transform: "rotate(180deg)" }} /> : <ArrowRight size={24} />}<b>{["LEFT", "CENTER", "RIGHT"][i]}</b><span>{["左レーン", "中央レーン", "右レーン"][i]}</span></button>)}</div></div><div className="control-block speed-control"><div className="control-block-heading"><span className="control-label">03 / SET YOUR SPEED</span><span>設定は次の操作まで継続</span></div><div className="speed-buttons">{(["slow", "normal", "turbo"] as Speed[]).map(speed => <button key={speed} aria-pressed={driver.speedMode === speed} disabled={!tokenReady || (race.phase === "finished" || race.phase === "cancelled")} className={driver.speedMode === speed ? "selected" : ""} onClick={() => void sendInput({ type: "speed", speed })}>{speed === "turbo" ? <Zap size={18} /> : <Gauge size={18} />}<b>{speed.toUpperCase()}</b></button>)}</div></div><div className="cockpit-stats"><div><span>SPEED</span><strong>{driver.speed.toFixed(1)}<small> u/s</small></strong></div><div><span>COLLISIONS</span><strong>{driver.collisionCount}</strong></div><div><span>STATUS</span><strong className="cockpit-status">{driver.slowedUntil > race.now ? "SLOWED" : sending ? "SENDING" : race.phase === "racing" ? "DRIVING" : race.phase.toUpperCase()}</strong></div></div><p className="driver-tip">車は自動で進みます。操作を止めてもレースは続きます。黄色い障害物を避けて、先に200ユニットを走り切ろう。</p></section></div><div className="cockpit-bottom"><Progress race={race} />{(race.phase === "finished" || race.phase === "cancelled") && <RaceOutcome race={race} />}</div></>}</main></div>;
}
