"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRaceSoundChannel } from "./race-sound";

type Phase = "lobby" | "countdown" | "racing" | "finished" | "cancelled";

/** A single spectator-owned player, controlled by the shared sound toolbar. */
export function RaceAudio({ phase, raceId, ducked = false }: { phase: Phase; raceId: string; ducked?: boolean }) {
  const { register, reportStatus } = useRaceSoundChannel("bgm");
  const audioRef = useRef<HTMLAudioElement>(null);
  const latest = useRef({ phase, raceId });
  const mounted = useRef(false);
  const enabled = useRef(true);
  const generation = useRef(0);
  const volume = useRef(.45);
  const duckedRef = useRef(ducked);

  const stop = useCallback(() => {
    generation.current++;
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = true;
    audio.pause();
    try { audio.currentTime = 0; } catch { /* Metadata is not loaded yet. */ }
  }, []);

  const start = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !mounted.current || !enabled.current) return;
    const attempt = ++generation.current;
    const requestedRace = latest.current.raceId;
    const isCurrent = () => mounted.current && attempt === generation.current && requestedRace === latest.current.raceId;
    audio.volume = volume.current * (duckedRef.current ? .22 : 1);
    // Unlock the same media element during preparation without audible music.
    audio.muted = latest.current.phase !== "racing";
    try {
      await audio.play();
      if (!isCurrent()) return;
      if (!enabled.current) { stop(); return; }
      if (latest.current.phase === "racing") {
        audio.muted = false;
        reportStatus("playing");
      } else {
        audio.pause();
        try { audio.currentTime = 0; } catch { /* Metadata is not loaded yet. */ }
        audio.muted = true;
        reportStatus("ready");
      }
    } catch (error) {
      if (!isCurrent()) return;
      audio.pause();
      audio.muted = true;
      reportStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "blocked" : "unavailable");
    }
  }, [reportStatus, stop]);

  useEffect(() => {
    mounted.current = true;
    latest.current = { phase, raceId };
    stop();
    const unregister = register({
      setEnabled(value) {
        enabled.current = value;
        if (value) {
          if (audioRef.current?.error) audioRef.current.load();
          void start();
        } else { stop(); reportStatus("ready"); }
      },
      setVolume(value) {
        volume.current = value / 100;
        if (audioRef.current) audioRef.current.volume = volume.current * (duckedRef.current ? .22 : 1);
      },
    });
    return () => { mounted.current = false; unregister(); stop(); };
  }, [phase, raceId, register, start, stop, reportStatus]);

  useEffect(() => {
    duckedRef.current = ducked;
    const audio = audioRef.current;
    if (!audio) return;
    const from = audio.volume;
    const startedAt = performance.now();
    let animation: number;
    const ramp = () => {
      const fraction = Math.min(1, (performance.now() - startedAt) / (ducked ? 140 : 450));
      const target = volume.current * (ducked ? .22 : 1);
      audio.volume = from + (target - from) * fraction;
      if (fraction < 1) animation = requestAnimationFrame(ramp);
    };
    animation = requestAnimationFrame(ramp);
    return () => cancelAnimationFrame(animation);
  }, [ducked]);

  return <audio ref={audioRef} src="/audio/turbo-battle-final-lap.mp3" preload="auto" loop hidden
    onError={() => { if (mounted.current) { stop(); reportStatus("unavailable"); } }} />;
}
