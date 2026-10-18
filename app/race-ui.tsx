"use client";

import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./spectator-stage.css";
import "./race-effects.css";
import "./brand.css";
import { requestRaceJson, raceRetryDelay } from "../lib/race-api";
import { RaceTimeline } from "../lib/race-timeline";
import { sanitizeDriveDecisionFeed, type DriveAction, type DriveDecision, type DriveDecisionFeed } from "../lib/drive-decision-feed";
import { CourseMap, RivalRadar, RouteControls, TacticalRoad } from "./race-tactics";
import { createCourseFeatures, COURSE_NAMES } from "../lib/race-course";
import type { CourseFeatures, RouteChoice } from "../lib/race-course";
import { RacePreparation } from "./race-preparation";
import { RaceArrival } from "./race-arrival";
import { isStalePreparation } from "../lib/race-launch";
import { RaceAudio } from "./race-audio";
import { RaceSoundProvider, RaceSoundControls } from "./race-sound";
import { NarrationBubble, RaceNarration } from "./race-narration";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleDot, Flag, Gauge, Maximize2, Monitor, Radio, Trophy, Zap } from "lucide-react";
const RaceCircuit3D = lazy(() => import("./race-circuit-3d").then(module => ({ default: module.RaceCircuit3D })));

type PlayerId = "red" | "blue";
type Speed = "slow" | "normal" | "turbo";
type Obstacle = { id: string; progress: number; blockedLane: 0 | 1 | 2; assetId?: string; placedAt?: number; junctionId?: string; route?: RouteChoice };
type Driver = {
  id: PlayerId; name: string; joined: boolean; ready: boolean; progress: number;
  lane: number; targetLane: 0 | 1 | 2; speedMode: Speed; speed: number;
  collisionCount: number; slowedUntil: number; upcomingObstacles: Obstacle[];
  jumpStartedAt?: number; jumpEndsAt?: number; jumpReadyAt?: number; jumpAvailable?: boolean;
  spinStartedAt?: number; spinEndsAt?: number; spinProgress?: number; spinLane?: number;
  routeChoices?: Record<string, RouteChoice>; carCollisions?: number; lastCarCollisionAt?: number; laneVelocity?: number;
};
type Race = {
  version?: number;
  phase: "lobby" | "countdown" | "racing" | "finished" | "cancelled";
  updatedAt: number; createdAt: number; countdownEndsAt: number | null; startedAt: number | null;
  finishedAt: number | null; winner: PlayerId | "tie" | null; remainingMs: number;
  players: Record<PlayerId, Driver>; course: { length: number; obstacles: Obstacle[] } & CourseFeatures;
};
type Telemetry = { status: string; frameAt: number | null; actions: number; sessionId?: string };
type RaceResponse = { state: Race; telemetry: Record<PlayerId, Telemetry> };
type Input = { type: "join" | "ready" | "jump" } | { type: "lane"; lane: 0 | 1 | 2 } | { type: "speed"; speed: Speed } | { type: "route"; junctionId: string; route: RouteChoice };
const COLORS = { red: "#ff5d58", blue: "#68a4ff" };
const NAMES = { red: "SCARLET", blue: "COBALT" };
const PHASE_LABELS = { lobby: "ドライバー接続待ち", countdown: "スタートまもなく", racing: "レース進行中", finished: "チェッカーフラッグ", cancelled: "レース中止" };
const enc = encodeURIComponent;

function Brand() {
  return <a className="brand brand-logo" href="/" aria-label="AgentRacer ホーム"><img src="/branding/agentracer-logo.png" alt="AgentRacer" width={2172} height={724} fetchPriority="high" /></a>;
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
  const timeline = useRef(new RaceTimeline<Race>());
  const lastAcceptedAt = useRef(-Infinity);
  const sampleRace = useCallback((timestamp: number) => timeline.current.sample(timestamp), []);
  const retry = useCallback(() => setRetryVersion(v => v + 1), []);
  const accept = useCallback((response: RaceResponse) => {
    if (response.state.updatedAt < lastAcceptedAt.current) return;
    lastAcceptedAt.current = response.state.updatedAt;
    const received = performance.now();
    timeline.current.push(response.state, received);
    setData(previous => previous && previous.state.updatedAt > response.state.updatedAt ? previous : response);
    setReceivedAt(received);
  }, []);
  useEffect(() => {
    timeline.current.clear();
    lastAcceptedAt.current = -Infinity;
    setData(null);
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
        if (!disposed) {
          accept(json); setError("");
        }
      } catch (e) {
        failure = e; failures++;
        if (!disposed) setError(e instanceof Error ? e.message : "接続を確認しています");
      }
      if (!disposed) timer = setTimeout(poll, raceRetryDelay(failures, failure, nextInterval));
    }
    void poll();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); };
  }, [id, interval, retryVersion, accept]);
  return { data, error, receivedAt, retry, sampleRace, accept };
}

function useRaceClockNow(race: Race | undefined, receivedAt: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!race || race.phase === "finished" || race.phase === "cancelled") return;
    const timer = setInterval(() => setTick(performance.now()), 100);
    return () => clearInterval(timer);
  }, [race?.phase]);
  if (!race) return 0;
  const elapsedMs = Math.max(0, tick - receivedAt);
  return race.updatedAt + Math.min(elapsedMs, 1000);
}
function useDriveDecisions(id: string, ended: boolean) {
  const [feed, setFeed] = useState<DriveDecisionFeed>({ red: null, blue: null });
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setFeed({ red: null, blue: null });
    setUnavailable(false);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: AbortController | null = null;
    async function poll() {
      if (disposed || document.hidden || current) return;
      const controller = new AbortController();
      current = controller;
      try {
        const result = sanitizeDriveDecisionFeed(await requestRaceJson(`/api/races/${enc(id)}/decisions`, { signal: controller.signal }));
        if (!disposed && !controller.signal.aborted) { setFeed(result); setUnavailable(false); }
      } catch {
        if (!disposed && !controller.signal.aborted) setUnavailable(true);
      } finally {
        if (current === controller) {
          current = null;
          if (!disposed && !document.hidden) timer = setTimeout(poll, ended ? 10000 : 2500);
        }
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      current?.abort();
      current = null;
      if (!document.hidden) void poll();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => { disposed = true; clearTimeout(timer); current?.abort(); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [id, ended]);
  return { feed, unavailable };
}
function Car({ color, compact = false }: { color: PlayerId; compact?: boolean }) {
  return <g className={compact ? "car-compact" : ""}><rect x="-17" y="-15" width="8" height="11" rx="2" fill="#111519" /><rect x="9" y="-15" width="8" height="11" rx="2" fill="#111519" /><rect x="-17" y="6" width="8" height="12" rx="2" fill="#111519" /><rect x="9" y="6" width="8" height="12" rx="2" fill="#111519" /><rect x="-12" y="-26" width="24" height="53" rx="8" fill={COLORS[color]} /><path d="M-9 -22H9L7 -4H-7Z" fill="white" opacity=".2" /><path d="M-8 0H8L7 13H-7Z" fill="#131e2a" /><rect x="-3" y="-23" width="6" height="20" rx="2" fill="#fff5d9" /><rect x="-16" y="21" width="32" height="6" rx="2" fill={COLORS[color]} /><rect x="-15" y="-24" width="30" height="4" rx="1" fill="#fff5d9" /></g>;
}
function Circuit({ race }: { race?: Race | null; decorative?: boolean }) {
  return race ? <CourseMap race={race} /> : null;
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function SceneFallback({ race, decorative, sampleRace }: { race: Race; decorative: boolean; sampleRace?: (timestamp: number) => Race | undefined }) {
  const [sampled, setSampled] = useState<Race | null>(null);
  useEffect(() => {
    setSampled(null);
    if (!sampleRace || race.phase !== "racing") return;
    const sample = () => setSampled(sampleRace(performance.now()) ?? null);
    sample();
    const timer = setInterval(sample, 100);
    return () => clearInterval(timer);
  }, [sampleRace, race.phase, race.createdAt]);
  const displayed = race.phase === "racing" && sampled?.createdAt === race.createdAt ? sampled : race;
  return <div className="scene-fallback"><p role="status">3D表示を利用できないため、2Dでレースを表示しています。</p><Circuit race={displayed} decorative={decorative} /></div>;
}
function SpectatorCircuit({ race, decorative = false, sampleRace }: { race: Race & { now?: number }; decorative?: boolean; sampleRace?: (timestamp: number) => Race | undefined }) {
  const [unavailable, setUnavailable] = useState(false);
  const fail = useCallback(() => setUnavailable(true), []);
  const fallback = <SceneFallback race={race} decorative={decorative} sampleRace={sampleRace} />;
  if (unavailable) return fallback;
  return <SceneBoundary fallback={fallback}><Suspense fallback={<div className="scene-loading" role="status"><span />3Dサーキットを準備しています</div>}><RaceCircuit3D race={race} sampleRace={sampleRace} decorative={decorative} onUnavailable={fail} /></Suspense></SceneBoundary>;
}
function previewRace(progress: number): Race & { now: number } {
  const driver = (id: PlayerId, offset: number, lane: number): Driver => ({ id, name: NAMES[id], joined: true, ready: true, progress: (progress + offset) % 200, lane, targetLane: lane as 0 | 1 | 2, speedMode: "normal", speed: 1.8, collisionCount: 0, slowedUntil: 0, upcomingObstacles: [] });
  return { phase: "racing", updatedAt: 0, createdAt: 0, countdownEndsAt: null, startedAt: 0, finishedAt: null, winner: null, remainingMs: 180000, now: progress * 1000, players: { red: driver("red", 0, 0), blue: driver("blue", 18, 2) }, course: { ...createCourseFeatures("preview-harbor", 200), length: 200, obstacles: [25,50,75,100,125,150,175].map((p,i) => ({ id: `preview-${i}`, progress: p, blockedLane: (i % 3) as 0 | 1 | 2 })) } };
}

export function HomeScreen() {
  return <><SiteHeader /><main className="home-main"><section className="home-hero"><div className="eyebrow"><span className="tiny-line" />THE COMPUTER USE RACING EXPERIMENT</div><h1>Two agents.<br /><span>One finish line.</span></h1><p className="home-description">画面を見る。ハンドルを切る。勝利を狙う。<br />2つのAIエージェントが、リアルタイムで競うレース。</p><RaceArrival /><div className="hero-actions"><a className="button button-lime" href="/preview/roadster">3Dプレビュー<ArrowUpRight size={17} /></a><a className="subtle-link" href="/preview/narration">AI実況を試聴<ArrowUpRight size={15} /></a><a className="subtle-link" href="http://127.0.0.1:4180/">オペレーター画面<ArrowUpRight size={15} /></a></div><div className="hero-facts"><span><b>02</b> INDEPENDENT AGENTS</span><span><b>03</b> LANES</span><span><b>∞</b> POSSIBILITIES</span></div></section><section className="home-track"><div className="track-topline"><span><CircleDot size={13} />TOKYO CIRCUIT</span><span>REAL-TIME SIMULATION</span></div><SpectatorCircuit race={previewRace(30)} decorative /><div className="home-versus"><span className="red-text">01 / SCARLET</span><span>VS</span><span className="blue-text">02 / COBALT</span></div></section><section className="how-it-works"><div><span className="step">01 / SEE</span><h2>それぞれの視点で</h2><p>独立したクラウドブラウザーで、相手車両・コース・障害物を観察。</p></div><div><span className="step">02 / DECIDE</span><h2>操作を決める</h2><p>Decisions APIが画面から進路・レーン・速度を選び、Computer Useが操作。</p></div><div><span className="step">03 / RACE</span><h2>時間は止まらない</h2><p>判断している間もレースは進行。先にゴールしたAIの勝利。</p></div></section><p className="operator-note">このページを開くと、開催中のレースへ自動で合流します。開催前なら、主催者のオペレーターが新しい対戦を準備します。</p></main><Footer /></>;
}
export function RoadsterPreviewScreen() {
  const [initial] = useState(() => previewRace(0));
  const start = useRef<number | null>(null);
  const sampleRace = useCallback((now: number) => {
    if (start.current === null) start.current = now;
    const elapsed = now - start.current;
    const progress = elapsed / 1000 * 8;
    return { ...initial, now: elapsed, players: {
      red: { ...initial.players.red, progress: progress % initial.course.length },
      blue: { ...initial.players.blue, progress: (progress + 18) % initial.course.length },
    } };
  }, [initial]);
  return <div className="spectator-shell preview-shell"><SiteHeader /><main className="spectator-main"><div className="race-heading"><div><div className="eyebrow">TESLA ROADSTER / MODEL PREVIEW</div><h1>Roadster <em>preview.</em></h1><p>3Dサーキットのデモ走行です。実際のAI対戦とは別のプレビューです。</p></div><a className="subtle-link" href="/">ホームに戻る<ArrowUpRight size={15} /></a></div><section className="track-panel spectator-track"><div className="track-topline"><span><CircleDot size={13} />MODEL PREVIEW</span><span>RED · BLUE · 8 U/S</span></div><div className="spectator-stage"><SpectatorCircuit race={initial} sampleRace={sampleRace} /></div></section></main></div>;
}
export function NarrationPreviewScreen() {
  const [initial] = useState(() => previewRace(0));
  const [captions, setCaptions] = useState<{ id: string; text: string; startMs: number; endMs: number }[]>([]);
  const [cursor, setCursor] = useState(0);
  const [sampleDuration, setSampleDuration] = useState<number | null>(null);
  const [sampleAudioUrl, setSampleAudioUrl] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(90);
  const [sampleError, setSampleError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const start = useRef<number | null>(null);
  const sampleRace = useCallback((now: number) => {
    if (start.current === null) start.current = now;
    const elapsed = now - start.current;
    const progress = elapsed / 1000 * 8;
    return { ...initial, now: elapsed, players: {
      red: { ...initial.players.red, progress: progress % initial.course.length },
      blue: { ...initial.players.blue, progress: (progress + 18) % initial.course.length },
    } };
  }, [initial]);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | undefined;
    // A local Blob remains seekable even if the CDN ignores HTTP range requests.
    void fetch("/audio/hayate-commentary-demo.wav", { signal: abort.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Sample audio unavailable");
      const audio = await response.blob();
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(audio);
      setSampleAudioUrl(objectUrl);
    }).catch(() => { if (!abort.signal.aborted) setSampleError("収録音声を読み込めませんでした"); });
    void fetch("/audio/hayate-commentary-demo.json", { signal: abort.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Sample unavailable");
      const data = await response.json() as { captions?: typeof captions };
      if (!Array.isArray(data.captions) || !data.captions.every(item => typeof item.id === "string" && typeof item.text === "string" && Number.isFinite(item.startMs) && Number.isFinite(item.endMs))) throw new Error("Invalid sample");
      if (!abort.signal.aborted) setCaptions(data.captions);
    }).catch(() => { if (!abort.signal.aborted) setSampleError("収録サンプルを読み込めませんでした"); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setCursor((audioRef.current?.currentTime || 0) * 1000), 80);
    return () => clearInterval(timer);
  }, [playing]);
  const playSample = async (silent: boolean, fromMs?: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = silent;
    audio.volume = volume / 100;
    setMuted(silent);
    if (fromMs !== undefined || audio.ended) {
      audio.currentTime = (fromMs ?? 0) / 1000;
      setCursor(fromMs ?? 0);
    }
    try { await audio.play(); setSampleError(""); }
    catch { setSampleError("再生ボタンを押すと音声を有効にできます"); }
  };
  const caption = captions.filter(item => item.startMs <= cursor && cursor < item.endMs + 1200).at(-1);
  const scenes = [{ label: "スタート", pattern: /スタート/ }, { label: "障害物", pattern: /障害物/ }, { label: "接触", pattern: /両車.*接触|車同士.*接触/ }, { label: "ゴール", pattern: /ゴール/ }];
  return <div className="spectator-shell narration-preview-shell"><SiteHeader />
    <audio ref={audioRef} src={sampleAudioUrl} preload="auto" hidden onLoadedMetadata={() => setSampleDuration(audioRef.current?.duration || null)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setCursor((audioRef.current?.currentTime || 0) * 1000)} onError={() => setSampleError("収録音声を読み込めませんでした")} />
    <main className="spectator-main">
      <div className="race-heading"><div><div className="eyebrow">GPT-LIVEで生成した実況サンプル / 収録再生</div><h1>The voice of <em>the race.</em></h1></div><a className="subtle-link" href="/">ホームへ戻る<ArrowUpRight size={15} /></a></div>
      <div className="spectator-toolbar narration-preview-controls">
        <button type="button" aria-pressed={playing} onClick={() => playing ? audioRef.current?.pause() : void playSample(muted)}>{playing ? "一時停止" : "実況を再生"}</button>
        <button type="button" onClick={() => void playSample(true)}>字幕だけで再生</button>
        {scenes.map(scene => { const entry = captions.find(item => scene.pattern.test(item.text)); return <button type="button" className="narration-scene-jump" key={scene.label} disabled={!entry} onClick={() => void playSample(muted, entry ? Math.max(0, entry.startMs - 100) : 0)}>{scene.label}</button>; })}
        <small>{(cursor / 1000).toFixed(1)}s / {sampleDuration?.toFixed(1) ?? "--"}s · 収録サンプル</small>
      </div>
      <div className="race-dashboard">
        <section className="track-panel spectator-track" aria-label="3Dと収録実況のプレビュー">
          <div className="track-topline"><span><CircleDot size={13} />RECORDED GPT-LIVE SAMPLE</span><span>3D DEMO DRIVE</span></div>
          <div className="spectator-stage"><SpectatorCircuit race={initial} sampleRace={sampleRace} /></div>
          <NarrationBubble text={caption?.text || ""} active={Boolean(caption)} speaking={playing && !muted && volume > 0 && Boolean(caption)} recorded
            status={sampleError || (playing ? "GPT-Liveの収録サンプルを再生しています" : "「実況を再生」でピット・ハヤテの声を試聴できます")}
            audioState={!muted && playing ? "playing" : "off"} volume={volume}
            onToggleAudio={() => { if (playing && !muted) { setMuted(true); if (audioRef.current) audioRef.current.muted = true; } else void playSample(false); }}
            onVolumeChange={next => { setVolume(next); if (audioRef.current) audioRef.current.volume = next / 100; }} />
          <div className="course-summary"><strong>音声・字幕は実際のGPT-Live出力</strong><span>3Dは別のデモ走行です</span></div>
          <Progress race={initial} />
        </section>
        <aside className="race-sidebar" aria-label="エージェント画面の配置サンプル">
          {(["red", "blue"] as PlayerId[]).map(player => <div className={`agent-observer ${player}`} key={player}>
            <div className={`camera-panel ${player}`}><div className="camera-header"><span><Monitor size={15} /><b>{NAMES[player]}</b><small>LAYOUT PREVIEW</small></span></div><div className="camera-content"><div className="camera-placeholder"><Monitor size={32} /><p>ここにエージェントの画面を表示</p><span>実際の映像はAI対戦中に届きます</span></div></div></div>
          </div>)}
        </aside>
      </div>
      <div className="spectator-note"><CircleDot size={12} /><span>収録サンプルの再生です。新しい音声生成やAI対戦は行いません。3Dのデモ走行と実況の出来事は連動しません。</span></div>
    </main>
  </div>;
}
function Footer() { return <footer className="site-footer"><span>AgentRacer</span><span>BUILT WITH OPENAI AGENTS API + COMPUTER USE</span><span>DEMO / 2026</span></footer>; }
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
const DECISION_LABELS: Record<DriveAction, string> = {
  lane_left: "左レーンへ", lane_center: "中央レーンへ", lane_right: "右レーンへ",
  speed_slow: "減速する", speed_normal: "通常速度へ", speed_turbo: "ターボで加速",
  route_left: "左の分岐へ", route_right: "右の分岐へ", jump: "ジャンプ", wait: "今の操作を維持",
};
function DecisionStrip({ decision, ended, unavailable }: { decision?: DriveDecision | null; ended: boolean; unavailable: boolean }) {
  const age = decision ? Math.max(0, Math.floor((Date.now() - decision.decidedAt) / 1000)) : 0;
  const stale = age > 15;
  const selected = decision?.status === "decided" && decision.action;
  const action = selected ? DECISION_LABELS[selected] : decision?.status === "retry" ? "新しい画面で再判断" : decision?.status === "error" ? "判断APIの接続を確認中" : ended ? "判断記録はありません" : "判断の到着待ち";
  const caption = unavailable ? "表示に再接続中" : ended ? "最終記録" : stale ? `前回の判断 · ${age}秒前` : selected ? "選択した操作" : "状況を確認中";
  return <div className={`decision-strip ${selected && !stale && !ended && !unavailable ? "decision-current" : ""}`} aria-label="Decisions APIの判断">
    <div className="decision-strip-heading"><span><i />DECISIONS API</span><small>{decision ? `#${decision.count}` : "—"}{decision?.latencyMs !== null && decision?.latencyMs !== undefined ? ` · ${(decision.latencyMs / 1000).toFixed(2)}s` : ""}</small></div>
    <div className="decision-strip-choice"><strong>{action}</strong><small>{caption}</small></div>
  </div>;
}
function CameraPanel({ raceId, id, telemetry, decision, ended = false, decisionsUnavailable = false }: { raceId: string; id: PlayerId; telemetry?: Telemetry; decision?: DriveDecision | null; ended?: boolean; decisionsUnavailable?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
  const src = telemetry?.frameAt ? `/api/races/${enc(raceId)}/frame/${id}?t=${telemetry.frameAt}` : null;
  return <section className={`camera-panel ${id} ${expanded ? "camera-expanded" : ""}`} aria-label={`${NAMES[id]}のエージェント画面`}><div className="camera-header"><span><Monitor size={15} /><b>{NAMES[id]}</b><small>AGENT VIEW</small></span><button aria-label={expanded ? "映像を縮小（Escape）" : `${NAMES[id]}の映像を拡大`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Maximize2 size={15} /></button></div><div className="camera-content">{src ? <img src={src} decoding="async" alt={`${NAMES[id]}のComputer Useセッションが取得した実際のブラウザー画面`} /> : <div className="camera-placeholder"><Monitor size={32} strokeWidth={1} /><p>エージェントの視点を待っています</p><span>実際のComputer Useスクリーンショットがここに届きます</span></div>}</div><DecisionStrip decision={decision} ended={ended} unavailable={decisionsUnavailable} /><div className="camera-footer"><span><i className={src ? "active" : ""} />{telemetry?.status || "WAITING FOR SESSION"}</span><span>{telemetry?.frameAt ? new Date(telemetry.frameAt).toLocaleTimeString("ja-JP", { hour12: false }) : "—"}</span></div></section>;
}
function LoadingRace({ error, onRetry }: { error: string; onRetry?: () => void }) { return <div className="loading-race"><Flag size={32} /><h1>{error ? "レースへの接続を確認中" : "サーキットを準備しています"}</h1><p role="status">{error || "2つのエージェントを迎える準備中…"}</p>{error && onRetry && <button className="button button-lime" type="button" onClick={onRetry}>再接続する</button>}<a href="/">ホームへ戻る</a></div>; }
function NextRacePanel({ id, compact = false }: { id: string; compact?: boolean }) {
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
  return <section className={`next-race-panel ${compact ? "compact" : ""}`} aria-label="次のレース">
    {!compact && <div><span className="eyebrow">READY FOR ANOTHER RACE?</span><h2>もう一度、スタートラインへ。</h2><p>この試合は終了しました。新しいレースは2つの新しいセッションで始まります。</p></div>}
    <div className="next-race-actions">
      {nextId && <a className="button button-lime" href={`/race/${enc(nextId)}`}><Radio size={17} />次のレースを観戦する<ArrowUpRight size={17} /></a>}
      <a className={nextId ? "button button-muted" : "button button-lime"} href="/" title="新しいレースを準備します。開催中のレースがあれば合流します。">もう一度レースする<ArrowUpRight size={17} /></a>
      {!compact && <small>新しい対戦を準備して、自動で観戦画面へ移動します。</small>}
    </div>
  </section>;
}
function RaceClock({ race, receivedAt }: { race: Race; receivedAt: number }) {
  const now = useRaceClockNow(race, receivedAt);
  const elapsed = Math.max(0, ((race.finishedAt || now) - (race.startedAt || race.createdAt)) / 1000);
  const countdown = race.countdownEndsAt ? Math.max(0, Math.ceil((race.countdownEndsAt - now) / 1000)) : 0;
  return <div className="race-clock"><span>{race.phase === "lobby" ? "PREPARATION TIME" : race.phase === "countdown" ? "START IN" : "RACE TIME"}</span><strong>{race.phase === "countdown" ? countdown : <>{Math.floor(elapsed / 60).toString().padStart(2, "0")}<i>:</i>{Math.floor(elapsed % 60).toString().padStart(2, "0")}<small>.{Math.floor(elapsed % 1 * 10)}</small></>}</strong></div>;
}
function CountdownOverlay({ race, receivedAt }: { race: Race; receivedAt: number }) {
  const now = useRaceClockNow(race, receivedAt);
  const countdown = race.countdownEndsAt ? Math.max(0, Math.ceil((race.countdownEndsAt - now) / 1000)) : 0;
  return <div className="countdown-overlay" role="status"><span>GET READY</span><strong>{countdown || "GO"}</strong></div>;
}
export function SpectatorScreen({ id }: { id: string }) {
  const [entry, setEntry] = useState<'checking' | 'watching' | 'launch'>('checking');
  const [narratorSpeaking, setNarratorSpeaking] = useState(false);
  const { data, error, receivedAt, retry, sampleRace } = useRace(id);
  const race = data?.state;
  const ended = race?.phase === "finished" || race?.phase === "cancelled";
  const decisions = useDriveDecisions(id, ended);
  useEffect(() => {
    setEntry('checking');
  }, [id]);
  useEffect(() => {
    // Only an ended race on arrival redirects. A race watched through its finish
    // retains its result, and does not create an endless chain of paid sessions.
    if (race && entry === 'checking') setEntry(ended || isStalePreparation(race, race.updatedAt) ? 'launch' : 'watching');
  }, [race, ended, entry]);
  if (entry === 'launch') return <div className="spectator-shell"><SiteHeader /><main className="arrival-screen"><RaceArrival previousRaceId={id} /></main></div>;
  if (entry === 'checking') return <div className="spectator-shell"><SiteHeader /><main className="spectator-main"><LoadingRace error={error} onRetry={retry} /></main></div>;

  return <RaceSoundProvider key={id}><div className="spectator-shell"><SiteHeader live={race?.phase === "racing"} />
    <main className="spectator-main">{!race ? <LoadingRace error={error} onRetry={retry} /> : <>
      <div className="race-heading">
        <div><div className="eyebrow">LIVE EXPERIMENT / TOKYO CIRCUIT</div><h1>{ended ? <>The race <em>results.</em></> : race.phase === "lobby" ? <>Preparing the <em>grid.</em></> : <>The race is <em>on.</em></>}</h1></div>
        <div className="race-heading-actions">{ended && <NextRacePanel id={id} compact />}<RaceClock race={race} receivedAt={receivedAt} /></div>
      </div>
      <div className="spectator-toolbar"><RaceAudio raceId={id} phase={race.phase} ducked={narratorSpeaking} /><RaceSoundControls />{error && <div className="connection-banner" role="status">再接続中 · 最後の状態を表示</div>}</div>
      <div className="race-dashboard">
        <section className="track-panel spectator-track" aria-label="メインの3Dレース画面">
          <div className="track-topline"><span><i className={`status-dot ${race.phase === "racing" ? "active" : ""}`} />{PHASE_LABELS[race.phase]}</span><span>3D LIVE · {race.course.length} UNITS · 3 LANES</span></div>
          <div className="spectator-stage"><SpectatorCircuit race={race} sampleRace={sampleRace} />
            {race.phase === "countdown" && <CountdownOverlay race={race} receivedAt={receivedAt} />}
            {race.phase === "lobby" && <RacePreparation createdAt={race.createdAt} serverNow={race.updatedAt} receivedAt={receivedAt} players={race.players} />}
            {ended && <RaceOutcome race={race} />}
          </div>
          <RaceNarration raceId={id} onSpeakingChange={setNarratorSpeaking} />
          {race.course.layout && <div className="course-summary"><strong>{COURSE_NAMES[race.course.layout]}</strong><span>2つの分岐 · 立体交差 · 車両同士の接触あり</span></div>}
          <Progress race={race} />
        </section>
        <aside className="race-sidebar" aria-label="AIが見ている実際の画面">
          {(["red", "blue"] as PlayerId[]).map(player => <div className={`agent-observer ${player}`} key={player}>
            <DriverCard id={player} driver={race.players[player]} telemetry={data?.telemetry[player]} phase={race.phase} />
            <CameraPanel raceId={id} id={player} telemetry={data?.telemetry[player]} decision={decisions.feed[player]} ended={ended} decisionsUnavailable={decisions.unavailable} />
          </div>)}
        </aside>
      </div>
      <div className="spectator-note"><CircleDot size={12} /><span>Decisions APIが判断し、Computer Useが操作。右の映像は各AIが取得した実際のスクリーンショットです。</span></div>
    </>}</main>
  </div></RaceSoundProvider>;
}

export function DriverScreen({ id, player }: { id: string; player: PlayerId }) {
  const { data, error, receivedAt, retry, accept } = useRace(id, 300);
  const now = useRaceClockNow(data?.state, receivedAt);
  const race = data?.state ? { ...data.state, now } : null;
  const token = useRef("");
  const jumpPending = useRef(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [inputError, setInputError] = useState("");
  const [sending, setSending] = useState(false);
  const sendInput = useCallback(async (input: Input) => {
    if (!token.current) { setInputError("参加用URLからこの画面を開いてください。"); return; }
    if (input.type === "jump" && jumpPending.current) return;
    if (input.type === "jump") jumpPending.current = true;
    setSending(true);
    try {
      const response = await requestRaceJson<RaceResponse>(`/api/races/${enc(id)}/input`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.current}` }, body: JSON.stringify({ player, input }) }, isRaceResponse);
      accept(response);
      setInputError("");
    } catch (e) { setInputError(e instanceof Error ? e.message : "操作を送信できませんでした"); }
    finally { if (input.type === "jump") jumpPending.current = false; setSending(false); }
  }, [id, player, accept]);
  useEffect(() => {
    try { token.current = decodeURIComponent(window.location.hash.slice(1)); } catch { token.current = ""; }
    setTokenReady(Boolean(token.current));
    if (token.current) void sendInput({ type: "join" });
  }, [sendInput]);
  const driver = race?.players[player];
  const targetLane = driver?.targetLane ?? 1;
  const airborne = race?.phase === "racing" && !!driver && now < (driver.jumpEndsAt ?? 0);
  const spinning = race?.phase === "racing" && !!driver && now < (driver.spinEndsAt ?? 0);
  const jumpWait = Math.max(0, (driver?.jumpReadyAt ?? 0) - now);
  const canJump = tokenReady && !!driver?.joined && race?.phase === "racing" && !airborne && !spinning && jumpWait === 0 && !jumpPending.current;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!tokenReady || race?.phase === "finished" || race?.phase === "cancelled") return;
      if (e.repeat || (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName))) return;
      if (e.code === "Space" && canJump) { e.preventDefault(); void sendInput({ type: "jump" }); }
      if (e.key === "ArrowLeft") { e.preventDefault(); void sendInput({ type: "lane", lane: Math.max(0, targetLane - 1) as 0 | 1 | 2 }); }
      if (e.key === "ArrowRight") { e.preventDefault(); void sendInput({ type: "lane", lane: Math.min(2, targetLane + 1) as 0 | 1 | 2 }); }
    }
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [sendInput, targetLane, tokenReady, race?.phase, canJump]);
  const next = driver?.upcomingObstacles.find(o => o.progress >= driver.progress);
  const countdown = race?.countdownEndsAt ? Math.max(0, Math.ceil((race.countdownEndsAt - race.now) / 1000)) : 0;
  return <div className={`driver-page ${player}`}><header className="cockpit-header"><Brand /><div><span className="driver-badge" style={{ color: COLORS[player] }}>YOU ARE {NAMES[player]}</span><span className="live-pill"><i />PLAYER {player === "red" ? "01" : "02"}</span></div></header><main className="cockpit-main">{!race || !driver ? <LoadingRace error={error} onRetry={retry} /> : <><div className="cockpit-title"><div><span className="eyebrow">REAL-TIME DRIVER COCKPIT</span><h1>{race.phase === "finished" ? "FINISHED" : race.phase === "cancelled" ? "RACE STOPPED" : race.phase === "countdown" ? `START IN ${countdown}` : race.phase === "racing" ? "RACE IN PROGRESS" : "READY TO RACE?"}</h1></div><div className="cockpit-distance"><strong>{driver.progress.toFixed(0)}<small> / {race.course.length}</small></strong><span>DISTANCE / UNITS</span></div></div>{(inputError || error || !tokenReady) && <div className="cockpit-error" role="alert">{inputError || error || "参加用URLが必要です。オペレーターから割り当てられたURLを開いてください。"}</div>}<div className="cockpit-grid"><section className="road-panel"><div className="road-heading"><span><CircleDot size={14} />FRONT VIEW</span><strong>60 UNITS AHEAD</strong></div><TacticalRoad race={race} player={player} /><RivalRadar race={race} player={player} /><CourseMap race={race} compact /><div className="obstacle-warning"><span className="obstacle-key" /><span>{next ? <>NEXT OBSTACLE: <b>{["LEFT", "CENTER", "RIGHT"][next.blockedLane]}</b> · {Math.max(0, next.progress - driver.progress).toFixed(0)} UNITS AHEAD</> : "CLEAR ROAD AHEAD"}</span></div></section><section className="controls-panel"><div className="ready-row"><div><span className="control-label">01 / JOIN THE GRID</span><p>{driver.ready ? "準備完了。両者READYで自動スタート。" : "READYを押してレースに参加。"}</p></div><button className={`ready-button ${driver.ready ? "is-ready" : ""}`} disabled={!tokenReady || !driver.joined || driver.ready || race.phase !== "lobby"} onClick={() => void sendInput({ type: "ready" })}>{driver.ready ? <><Check size={20} />READY</> : <>READY<Flag size={18} /></>}</button></div><RouteControls race={race} player={player} enabled={tokenReady && driver.joined && !sending && race.phase !== "finished" && race.phase !== "cancelled"} onChoose={(junctionId, route) => void sendInput({ type: "route", junctionId, route })} /><div className="control-block"><div className="control-block-heading"><span className="control-label">02 / CHOOSE YOUR LANE</span><span>車線を選ぶ（今の道路内）</span></div><div className="lane-buttons">{([0, 1, 2] as const).map((lane, i) => <button key={lane} aria-pressed={driver.targetLane === lane} disabled={!tokenReady || (race.phase === "finished" || race.phase === "cancelled")} className={driver.targetLane === lane ? "selected" : ""} onClick={() => void sendInput({ type: "lane", lane })}>{i === 0 ? <ArrowLeft size={24} /> : i === 1 ? <ArrowDown size={24} style={{ transform: "rotate(180deg)" }} /> : <ArrowRight size={24} />}<b>{["LEFT", "CENTER", "RIGHT"][i]}</b><span>{["左レーン", "中央レーン", "右レーン"][i]}</span></button>)}</div></div><div className="control-block speed-control"><div className="control-block-heading"><span className="control-label">03 / SET YOUR SPEED</span><span>設定は次の操作まで継続</span></div><div className="speed-buttons">{(["slow", "normal", "turbo"] as Speed[]).map(speed => <button key={speed} aria-pressed={driver.speedMode === speed} disabled={!tokenReady || (race.phase === "finished" || race.phase === "cancelled")} className={driver.speedMode === speed ? "selected" : ""} onClick={() => void sendInput({ type: "speed", speed })}>{speed === "turbo" ? <Zap size={18} /> : <Gauge size={18} />}<b>{speed.toUpperCase()}</b></button>)}</div></div><div className="jump-control"><div><span className="control-label">04 / AIR JUMP</span><p>{spinning ? `SPIN · 残り ${Math.max(0, ((driver.spinEndsAt ?? 0) - now) / 1000).toFixed(1)} 秒` : airborne ? "AIRBORNE · 空中の障害物を回避" : "0.8秒ジャンプ · 着地から2秒で再充填"}</p></div><button className="jump-button" disabled={!canJump || sending} onClick={() => void sendInput({ type: "jump" })} aria-label="JUMP"><ArrowUpRight size={22} /><b>JUMP</b><small>{race.phase !== "racing" ? "RACE ONLY" : airborne ? `AIR ${Math.max(0, ((driver.jumpEndsAt ?? 0) - now) / 1000).toFixed(1)}s` : spinning ? "SPINNING" : jumpWait > 0 ? `CHARGE ${(jumpWait / 1000).toFixed(1)}s` : race.phase === "racing" ? "READY / SPACE" : "RACE ONLY"}</small></button></div><div className="cockpit-stats"><div><span>SPEED</span><strong>{driver.speed.toFixed(1)}<small> u/s</small></strong></div><div><span>COLLISIONS</span><strong>{driver.collisionCount}</strong></div><div><span>STATUS</span><strong className="cockpit-status">{spinning ? "SPINNING" : airborne ? "AIRBORNE" : driver.slowedUntil > race.now ? "SLOWED" : sending ? "SENDING" : race.phase === "racing" ? "DRIVING" : race.phase.toUpperCase()}</strong></div></div><p className="driver-tip">車や障害物を回避。バナナに触れると1.2秒停止・スピンします。JUMPで障害物を飛び越えられます。スピン中のレーン・速度設定は回復後に反映。分岐は進入前に選択。</p></section></div><div className="cockpit-bottom"><Progress race={race} />{(race.phase === "finished" || race.phase === "cancelled") && <RaceOutcome race={race} />}</div></>}</main></div>;
}
