"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Music2, Volume2, VolumeX } from "lucide-react";
import "./race-audio.css";

type Phase = "lobby" | "countdown" | "racing" | "finished" | "cancelled";
type AudioStatus = "standby" | "ready" | "starting" | "playing" | "blocked" | "muted" | "error";

/** One spectator-owned audio element. Driver pages should not mount this component. */
export function RaceAudio({ phase, raceId, compact = false, ducked = false }: { phase: Phase; raceId: string; compact?: boolean; ducked?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const latest = useRef({ phase, raceId });
  useEffect(() => { latest.current = { phase, raceId }; }, [phase, raceId]);
  const mounted = useRef(false);
  const enabled = useRef(true);
  const armed = useRef(false);
  // Invalidates a pending play() when the user mutes, the phase changes, or we unmount.
  const generation = useRef(0);
  const volumeRef = useRef(0.45);
  const duckedRef = useRef(ducked);
  useEffect(() => { duckedRef.current = ducked; }, [ducked]);
  const [volume, setVolume] = useState(45);
  const [status, setStatus] = useState<AudioStatus>("standby");

  const stop = useCallback(() => {
    generation.current += 1;
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = true;
    audio.pause();
    // Seeking can throw before a browser has loaded any media metadata.
    try { audio.currentTime = 0; } catch { /* Already at the beginning. */ }
  }, []);

  const start = useCallback(async (prime: boolean) => {
    const audio = audioRef.current;
    if (!audio || !mounted.current || !enabled.current) return;
    const attempt = ++generation.current;
    const requestedRace = latest.current.raceId;
    const isCurrent = () => mounted.current && attempt === generation.current && requestedRace === latest.current.raceId;
    audio.volume = volumeRef.current * (duckedRef.current ? .22 : 1);
    // A preparation click exercises the same media element without making sound.
    // Browsers may still require another click when the race starts; handle that below.
    audio.muted = prime || latest.current.phase !== "racing";
    setStatus("starting");
    try {
      await audio.play();
      if (!isCurrent()) return;
      if (!enabled.current) { stop(); return; }
      if (latest.current.phase === "racing") {
        audio.muted = false;
        armed.current = true;
        setStatus("playing");
      } else {
        audio.pause();
        try { audio.currentTime = 0; } catch { /* Metadata may still be loading. */ }
        audio.muted = true;
        armed.current = true;
        setStatus("ready");
      }
    } catch (error) {
      if (!isCurrent()) return;
      audio.pause();
      audio.muted = true;
      // A denied autoplay is a recoverable browser policy, not an unavailable track.
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "blocked" : "error");
    }
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    stop();
    if (enabled.current && phase === "racing") void start(false);
    else setStatus(enabled.current ? (armed.current ? "ready" : "standby") : "muted");
    return () => {
      mounted.current = false;
      stop();
    };
  }, [phase, raceId, start, stop]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const from = audio.volume;
    const startedAt = performance.now();
    let animation: number;
    const ramp = () => {
      const fraction = Math.min(1, (performance.now() - startedAt) / (ducked ? 140 : 450));
      const target = volumeRef.current * (ducked ? .22 : 1);
      audio.volume = from + (target - from) * fraction;
      if (fraction < 1) animation = requestAnimationFrame(ramp);
    };
    animation = requestAnimationFrame(ramp);
    return () => cancelAnimationFrame(animation);
  }, [ducked]);

  const toggle = () => {
    if (status === "playing" || status === "ready" || status === "starting") {
      enabled.current = false;
      armed.current = false;
      stop();
      setStatus("muted");
      return;
    }
    enabled.current = true;
    if (status === "error") audioRef.current?.load();
    // Invoke play() directly inside this click, preserving the browser's user gesture.
    void start(latest.current.phase !== "racing");
  };

  const active = status === "playing" || status === "ready" || status === "starting";
  const ended = phase === "finished" || phase === "cancelled";
  const statusText = status === "playing" ? (volume === 0 ? "音量 0%・再生中" : "レースBGMを再生中")
    : status === "blocked" ? "クリックすると音楽が流れます"
    : status === "error" ? "音楽を読み込めませんでした"
    : status === "muted" ? "BGMはオフ"
    : ended ? "レース終了・BGM停止"
    : status === "ready" ? "走行開始に合わせて再生します"
    : status === "starting" ? "音楽を準備しています"
    : "レース中にBGMを再生";
  const buttonText = status === "playing" ? "ミュート"
    : status === "ready" || status === "starting" ? "BGMをオフ"
    : status === "error" ? "再試行"
    : status === "blocked" || phase === "racing" ? "音楽を再生"
    : "音楽を有効にする";

  return <section className={`race-audio ${status === "playing" ? "is-playing" : ""} ${compact ? "compact" : ""}`} aria-label="レースBGM">
    <audio ref={audioRef} src="/audio/turbo-battle-final-lap.mp3" preload="auto" loop hidden
      onError={() => { if (mounted.current) { stop(); setStatus("error"); } }} />
    <div className="race-audio-track">
      <span className="race-audio-icon" aria-hidden="true"><Music2 size={20} /></span>
      <div><span className="race-audio-kicker">RACE SOUNDTRACK</span><strong>Turbo Battle! — Final Lap</strong><span className="race-audio-status" role="status">{statusText}</span></div>
      <span className="race-audio-bars" aria-hidden="true"><i /><i /><i /><i /></span>
    </div>
    <div className="race-audio-controls">
      <button type="button" className="race-audio-toggle" aria-pressed={active} onClick={toggle}>
        {active ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}{buttonText}
      </button>
      <label className="race-audio-volume"><span>音量</span><input type="range" min="0" max="100" step="5" value={volume} aria-label="BGMの音量" aria-valuetext={`${volume}%`}
        onChange={event => { const next = Number(event.currentTarget.value); setVolume(next); volumeRef.current = next / 100; if (audioRef.current) audioRef.current.volume = next / 100 * (duckedRef.current ? .22 : 1); }} /><output>{volume}%</output></label>
    </div>
    <p className="race-audio-help">{status === "blocked" ? "ブラウザーの自動再生制限のため、ボタンを押して音声を有効にしてください。"
      : status === "error" ? "接続を確認して「再試行」を押してください。音楽なしでもレースは続きます。"
      : status === "standby" ? "待っている間に音楽を有効にできます。走行開始までは音を流しません。"
      : "走行中のみループ再生。準備中とレース終了後は停止します。"}</p>
  </section>;
}
