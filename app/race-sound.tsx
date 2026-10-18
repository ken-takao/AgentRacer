"use client";

import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AudioLines, Music2, SlidersHorizontal, Volume2 } from "lucide-react";
import { RaceSoundMixer, type SoundChannel, type SoundController, type SoundStatus } from "../lib/race-sound";
import "./race-audio.css";

const SoundContext = createContext<RaceSoundMixer | null>(null);
export function RaceSoundProvider({ children }: { children: ReactNode }) {
  const [mixer] = useState(() => new RaceSoundMixer());
  return <SoundContext.Provider value={mixer}>{children}</SoundContext.Provider>;
}
function useMixer() {
  const mixer = useContext(SoundContext);
  if (!mixer) throw new Error("Race audio requires RaceSoundProvider");
  return mixer;
}
export function useRaceSoundChannel(channel: SoundChannel) {
  const mixer = useMixer();
  const register = useCallback((controller: SoundController) => mixer.register(channel, controller), [mixer, channel]);
  const reportStatus = useCallback((status: SoundStatus) => mixer.reportStatus(channel, status), [mixer, channel]);
  return { register, reportStatus };
}
export function RaceSoundControls() {
  const mixer = useMixer();
  const channels = useSyncExternalStore(mixer.subscribe, mixer.getSnapshot, mixer.getSnapshot);
  const blocked = Object.values(channels).some(channel => channel.enabled && channel.status === "blocked");
  const unavailable = Object.values(channels).some(channel => channel.enabled && channel.status === "unavailable");
  return <section className="race-sound" aria-label="レースの音声">
    <div className="race-sound-switches">
      {(["bgm", "narration"] as const).map(channel => <button key={channel} type="button" className="race-sound-toggle"
        aria-pressed={channels[channel].enabled} onClick={() => mixer.toggle(channel)}>
        {channel === "bgm" ? <Music2 size={15} aria-hidden="true" /> : <AudioLines size={15} aria-hidden="true" />}
        {channel === "bgm" ? "BGM" : "実況"}<span>{channels[channel].enabled ? "ON" : "OFF"}</span>
      </button>)}
      <details className="race-sound-settings">
        <summary><SlidersHorizontal size={14} aria-hidden="true" />音量</summary>
        <div className="race-sound-volumes">
          {(["bgm", "narration"] as const).map(channel => <label key={channel}>
            <span>{channel === "bgm" ? "BGM" : "実況"}</span>
            <input type="range" min="0" max="100" step="5" value={channels[channel].volume}
              aria-label={`${channel === "bgm" ? "BGM" : "実況"}の音量`} aria-valuetext={`${channels[channel].volume}%`}
              onChange={event => mixer.setVolume(channel, Number(event.currentTarget.value))} />
            <output>{channels[channel].volume}%</output>
          </label>)}
        </div>
      </details>
    </div>
    {blocked || unavailable ? <button type="button" className="race-sound-resume" onClick={() => mixer.resumeEnabled()}
      title={blocked ? "ブラウザーの自動再生制限を解除して音声を再生" : "音声を再試行"}>
      <Volume2 size={14} aria-hidden="true" />{blocked ? "音声を再生" : "音声を再試行"}
    </button> : null}
    <span className="race-sound-sr" role="status">{blocked ? "自動再生が制限されています。音声を再生ボタンを押してください。" : unavailable ? "音声を読み込めませんでした。再試行できます。" : ""}</span>
  </section>;
}
