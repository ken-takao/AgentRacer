"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Headphones, Volume2, VolumeX } from "lucide-react";
import "./race-narration.css";

import type { NarrationFeed } from "../lib/narration-feed";
export type { NarrationFeed } from "../lib/narration-feed";

type Caption = NarrationFeed["captions"][number];
type AudioState = "off" | "playing" | "blocked" | "unavailable";
type SourceEntry = { source: AudioBufferSourceNode; startMs: number; endMs: number };
type Playback = {
  feed: NarrationFeed | null;
  clock: { cursor: number; at: number } | null;
  context: AudioContext | null;
  gain: GainNode | null;
  sources: Map<number, SourceEntry>;
  scheduled: Set<number>;
  buffers: Map<number, AudioBuffer>;
  pending: boolean;
  enabled: boolean;
  mediaStarted: boolean;
  buffering: boolean;
  disposed: boolean;
  revision: number;
};
const PLAYBACK_DELAY_MS = 3000;
const CAPTION_HOLD_MS = 1200;
const BUFFER_AHEAD_MS = 5000;
const REBUFFER_RESERVE_MS = 1500;

function isFeed(value: unknown, raceId: string): value is NarrationFeed {
  if (!value || typeof value !== "object") return false;
  const feed = value as NarrationFeed;
  return feed.version === 1 && feed.raceId === raceId && typeof feed.generationId === "string"
    && ["connecting", "live", "ended", "error"].includes(feed.status)
    && Number.isFinite(feed.startedAt) && Number.isFinite(feed.updatedAt)
    && Array.isArray(feed.chunks) && Array.isArray(feed.captions)
    && feed.chunks.every(chunk => Number.isInteger(chunk.seq) && typeof chunk.url === "string"
      && Number.isFinite(chunk.startMs) && Number.isFinite(chunk.durationMs) && chunk.durationMs > 0)
    && feed.captions.every(caption => typeof caption.id === "string" && typeof caption.text === "string"
      && Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs));
}
function publishedAudioEdge(feed: NarrationFeed) {
  return Math.max(0, ...feed.chunks.map(chunk => chunk.startMs + chunk.durationMs));
}
function mediaEdge(feed: NarrationFeed) {
  return Math.max(0, ...feed.chunks.map(chunk => chunk.startMs + chunk.durationMs), ...feed.captions.map(caption => caption.endMs));
}
function liveCursor(feed: NarrationFeed) {
  // Reserve three seconds of published audio. Model output, chunk assembly and
  // storage publication already consumed time before a chunk reaches this feed;
  // a wall-clock or transcript edge would incorrectly spend that reserve twice.
  const audioEdge = publishedAudioEdge(feed);
  const edge = feed.status === "ended" || feed.status === "error" ? mediaEdge(feed) : audioEdge;
  // Keep a negative cursor at session startup so the first words get the same
  // buffering time as later audio instead of being clipped while downloading.
  return Math.max(0, edge) - PLAYBACK_DELAY_MS;
}
function cursorNow(playback: Playback) {
  if (!playback.mediaStarted) return -PLAYBACK_DELAY_MS;
  if (playback.buffering) return playback.clock?.cursor ?? 0;
  return playback.clock ? playback.clock.cursor + performance.now() - playback.clock.at : 0;
}
function stopSources(playback: Playback) {
  for (const { source } of playback.sources.values()) {
    try { source.stop(); } catch { /* A source may already have reached its end. */ }
    source.disconnect();
  }
  playback.sources.clear();
  playback.scheduled.clear();
}
function chooseCaption(feed: NarrationFeed | null, cursor: number): Caption | null {
  if (!feed) return null;
  let selected: Caption | null = null;
  for (const caption of feed.captions) {
    if (caption.startMs <= cursor && cursor < Math.max(caption.endMs, caption.startMs + 500) + CAPTION_HOLD_MS
      && (!selected || caption.startMs >= selected.startMs)) selected = caption;
  }
  if (!selected && (feed.status === "ended" || feed.status === "error")) {
    // Keep the final actual transcript readable after the audio timeline drains.
    for (const caption of feed.captions) {
      if (caption.startMs <= cursor && (!selected || caption.startMs >= selected.startMs)) selected = caption;
    }
  }
  return selected;
}
function terminalReplayStart(feed: NarrationFeed) {
  if (!feed.chunks.length) return null;
  const earliest = Math.min(...feed.chunks.map(chunk => chunk.startMs));
  let latest: Caption | null = null;
  for (const caption of feed.captions) {
    const retained = feed.chunks.some(chunk => chunk.startMs < caption.endMs && chunk.startMs + chunk.durationMs > caption.startMs);
    if (retained && (!latest || caption.startMs > latest.startMs)) latest = caption;
  }
  return Math.max(earliest, latest ? latest.startMs - 150 : mediaEdge(feed) - 4000);
}
function emptyPlayback(): Playback {
  return { feed: null, clock: null, context: null, gain: null, sources: new Map(), scheduled: new Set(), buffers: new Map(), pending: false, enabled: false, mediaStarted: false, buffering: false, disposed: false, revision: 0 };
}

/** A single race-wide audio feed; this component never opens an AI session. */
export function RaceNarration(props: { raceId: string; onSpeakingChange?: (speaking: boolean) => void }) {
  return <RaceNarrationSession key={props.raceId} {...props} />;
}
function RaceNarrationSession({ raceId, onSpeakingChange }: { raceId: string; onSpeakingChange?: (speaking: boolean) => void }) {
  const playbackRef = useRef<Playback | null>(null);
  const speakingCallback = useRef(onSpeakingChange);
  useEffect(() => { speakingCallback.current = onSpeakingChange; }, [onSpeakingChange]);
  const volumeRef = useRef(.9);
  const [volume, setVolume] = useState(90);
  const [audioState, setAudioState] = useState<AudioState>("off");
  const [feedStatus, setFeedStatus] = useState<NarrationFeed["status"] | "missing">("connecting");
  const [caption, setCaption] = useState<Caption | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    const playback = emptyPlayback();
    playbackRef.current = playback;
    const abort = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let lastSpeaking = false;
    let captionKey = "";
    speakingCallback.current?.(false);

    function resetClock(feed: NarrationFeed) {
      stopSources(playback);
      playback.buffering = false;
      playback.clock = { cursor: liveCursor(feed), at: performance.now() };
    }
    function resumeBufferedPlayback() {
      const { feed, clock } = playback;
      if (!playback.buffering || !feed || !clock) return;
      const terminal = feed.status === "ended" || feed.status === "error";
      const available = publishedAudioEdge(feed) - clock.cursor;
      if (!terminal && available < REBUFFER_RESERVE_MS) return;
      if (playback.enabled && available > 0) {
        // Publication alone is insufficient: the first resumed sample must
        // already be decoded, otherwise its beginning would be clipped again.
        const first = feed.chunks.find(chunk => chunk.startMs <= clock.cursor + 1 && chunk.startMs + chunk.durationMs > clock.cursor);
        if (!first || !playback.buffers.has(first.seq)) return;
      }
      playback.buffering = false;
      playback.clock = { cursor: clock.cursor, at: performance.now() };
    }
    async function poll() {
      let delay = 700;
      try {
        const response = await fetch(`/api/races/${encodeURIComponent(raceId)}/narration`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), cache: "no-store" });
        if (response.status === 404) {
          if (!playback.disposed) { setFeedStatus("missing"); setConnectionError(false); }
          delay = 2500;
        } else {
          if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Narration feed unavailable");
          const feed: unknown = await response.json();
          if (!isFeed(feed, raceId)) throw new Error("Invalid narration feed");
          if (playback.disposed) return;
          if (feed.generationId !== playback.feed?.generationId || feed.startedAt !== playback.feed?.startedAt) {
            playback.revision++;
            playback.mediaStarted = feed.chunks.length > 0;
            playback.buffers.clear();
            resetClock(feed);
          } else if (!playback.mediaStarted && feed.chunks.length > 0) {
            // The connecting feed must not start a clock before audio exists.
            playback.mediaStarted = true;
            resetClock(feed);
          } else if (playback.mediaStarted && playback.clock && (feed.status === "connecting" || feed.status === "live")
            && liveCursor(feed) - cursorNow(playback) > 5500) {
            // Only skip forward after a long stall. Never rewind on normal
            // publication jitter, which would replay audio and cause jumps.
            resetClock(feed);
          }
          playback.feed = feed;
          setFeedStatus(feed.status);
          setConnectionError(false);
          delay = feed.status === "ended" || feed.status === "error" ? 5000 : 700;
        }
        failures = 0;
      } catch {
        if (playback.disposed) return;
        failures++;
        setConnectionError(true);
        delay = Math.min(8000, 700 * 2 ** Math.min(failures, 4));
      }
      if (!playback.disposed) pollTimer = setTimeout(poll, delay);
    }

    async function fillAudio() {
      const { context, gain, feed } = playback;
      if (!feed || !context || !gain || !playback.enabled || playback.pending || context.state !== "running") return;
      playback.pending = true;
      const revision = playback.revision;
      const cursor = cursorNow(playback);
      const chunks = feed.chunks.filter(chunk => chunk.startMs + chunk.durationMs > cursor && chunk.startMs < cursor + BUFFER_AHEAD_MS)
        .sort((a, b) => a.startMs - b.startMs);
      try {
        await Promise.allSettled(chunks.filter(chunk => !playback.buffers.has(chunk.seq)).slice(0, 5).map(async chunk => {
          const url = new URL(chunk.url, window.location.origin);
          if (url.origin !== window.location.origin) throw new Error("Unexpected narration audio origin");
          const response = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), cache: "force-cache" });
          if (!response.ok) throw new Error("Narration audio unavailable");
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 1024 * 1024) throw new Error("Narration audio chunk too large");
          const buffer = await context.decodeAudioData(bytes);
          if (!playback.disposed && playback.revision === revision) playback.buffers.set(chunk.seq, buffer);
        }));
        if (playback.disposed || playback.revision !== revision || !playback.enabled || context.state !== "running") return;
        resumeBufferedPlayback();
        if (playback.buffering) return;
        for (const chunk of chunks) {
          if (playback.scheduled.has(chunk.seq)) continue;
          const buffer = playback.buffers.get(chunk.seq);
          if (!buffer) continue;
          const nowCursor = cursorNow(playback);
          const offset = Math.max(0, (nowCursor - chunk.startMs) / 1000);
          if (offset >= buffer.duration) { playback.scheduled.add(chunk.seq); continue; }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(gain);
          const when = context.currentTime + Math.max(0, (chunk.startMs - nowCursor) / 1000);
          playback.sources.set(chunk.seq, { source, startMs: Math.max(chunk.startMs, nowCursor), endMs: chunk.startMs + buffer.duration * 1000 });
          playback.scheduled.add(chunk.seq);
          source.onended = () => { if (playback.sources.get(chunk.seq)?.source === source) playback.sources.delete(chunk.seq); source.disconnect(); };
          source.start(when, offset);
        }
      } catch {
        // A transient chunk error does not block later audio or the independent captions.
      } finally {
        playback.pending = false;
      }
    }
    const tick = () => {
      if (playback.disposed) return;
      if (playback.enabled && playback.context?.state === "suspended") {
        playback.enabled = false;
        stopSources(playback);
        setAudioState("blocked");
      }
      if (playback.buffering && (!playback.enabled || (playback.feed && publishedAudioEdge(playback.feed) <= (playback.clock?.cursor ?? 0)))) resumeBufferedPlayback();
      let cursor = cursorNow(playback);
      if (!playback.buffering && playback.mediaStarted && playback.feed?.status === "live"
        && cursor >= publishedAudioEdge(playback.feed)) {
        // Stop at the last real PCM sample. Both subtitles and audio wait here;
        // no extrapolated silence or repeated words are inserted during a stall.
        cursor = publishedAudioEdge(playback.feed);
        stopSources(playback);
        playback.buffering = true;
        playback.clock = { cursor, at: performance.now() };
      }
      if (playback.enabled && playback.feed && (playback.feed.status === "ended" || playback.feed.status === "error")
        && cursor >= mediaEdge(playback.feed) + 100 && playback.sources.size === 0) {
        // Make the next click a replay, and never keep BGM ducked after completion.
        playback.enabled = false;
        if (playback.gain) playback.gain.gain.value = 0;
        setAudioState("off");
      }
      const nextCaption = chooseCaption(playback.feed, cursor);
      const key = nextCaption ? `${nextCaption.id}:${nextCaption.text}` : "";
      if (key !== captionKey) { captionKey = key; setCaption(nextCaption); }
      const voicePlaying = playback.enabled && playback.context?.state === "running" && volumeRef.current > 0
        && Boolean(nextCaption && cursor <= nextCaption.endMs)
        && [...playback.sources.values()].some(source => source.startMs <= cursor && cursor < source.endMs);
      if (voicePlaying !== lastSpeaking) {
        lastSpeaking = voicePlaying;
        setSpeaking(voicePlaying);
        speakingCallback.current?.(voicePlaying);
      }
      for (const [seq] of playback.buffers) {
        const chunk = playback.feed?.chunks.find(item => item.seq === seq);
        if (!chunk || chunk.startMs + chunk.durationMs < cursor - 1000) {
          playback.buffers.delete(seq);
          playback.scheduled.delete(seq);
        }
      }
      void fillAudio();
    };
    const resumeVisible = () => {
      if (document.visibilityState === "visible" && playback.feed?.status === "live") resetClock(playback.feed);
    };
    document.addEventListener("visibilitychange", resumeVisible);
    const tickTimer = setInterval(tick, 100);
    void poll();
    return () => {
      playback.disposed = true;
      playback.revision++;
      abort.abort();
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      document.removeEventListener("visibilitychange", resumeVisible);
      stopSources(playback);
      void playback.context?.close();
      playback.buffers.clear();
      speakingCallback.current?.(false);
      if (playbackRef.current === playback) playbackRef.current = null;
    };
  }, [raceId]);

  const toggleAudio = useCallback(async () => {
    const playback = playbackRef.current;
    if (!playback || playback.disposed) return;
    if (playback.enabled) {
      playback.enabled = false;
      if (playback.gain) playback.gain.gain.value = 0;
      stopSources(playback);
      setAudioState("off");
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) { setAudioState("unavailable"); return; }
      if (!playback.context) {
        playback.context = new AudioContextClass();
        playback.gain = playback.context.createGain();
        playback.gain.connect(playback.context.destination);
      }
      // resume() is invoked within the button gesture, never by the polling loop.
      await playback.context.resume();
      if (playback.disposed) return;
      if (playback.context.state !== "running") { setAudioState("blocked"); return; }
      const feed = playback.feed;
      if (feed && (feed.status === "ended" || feed.status === "error") && cursorNow(playback) >= mediaEdge(feed) - 350) {
        const replayStart = terminalReplayStart(feed);
        if (replayStart === null) { setAudioState("unavailable"); return; }
        stopSources(playback);
        playback.buffering = false;
        // Give retained chunks the same download buffer as a live connection.
        playback.clock = { cursor: replayStart, at: performance.now() + PLAYBACK_DELAY_MS };
      }
      playback.enabled = true;
      playback.gain!.gain.value = volumeRef.current;
      setAudioState("playing");
    } catch { if (!playback.disposed) setAudioState("blocked"); }
  }, []);

  const changeVolume = useCallback((value: number) => {
    setVolume(value);
    volumeRef.current = value / 100;
    const playback = playbackRef.current;
    if (playback?.gain && playback.context) playback.gain.gain.setTargetAtTime(playback.enabled ? value / 100 : 0, playback.context.currentTime, .03);
  }, []);
  const statusText = connectionError ? "実況に再接続中 · レースは続いています"
    : feedStatus === "missing" ? "このレースには実況音声がありません"
    : feedStatus === "error" ? "実況は一時停止中 · レースは続いています"
    : feedStatus === "ended" ? "本日の実況を終えました"
    : feedStatus === "connecting" ? "実況ブースに接続しています"
    : "2台の走りを、ここから生実況。";
  return <NarrationBubble text={caption?.text || ""} active={Boolean(caption)} speaking={speaking}
    status={statusText} live={feedStatus === "live"} replay={feedStatus === "ended" || feedStatus === "error"} audioState={audioState} volume={volume}
    onToggleAudio={toggleAudio} onVolumeChange={changeVolume} />;
}

/** Presentational export also used for deterministic visual previews without an API call. */
export function NarrationBubble({ text, active = false, speaking = false, status = "2台の走りを、ここから生実況。", live = false, audioState = "off", volume = 90, onToggleAudio, onVolumeChange, preview = false, recorded = false, replay = false }: {
  text: string; active?: boolean; speaking?: boolean; status?: string; live?: boolean;
  audioState?: AudioState; volume?: number; preview?: boolean; recorded?: boolean; replay?: boolean; onToggleAudio?: () => void; onVolumeChange?: (value: number) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const exciting = active && /ゴール|接触|逆転|抜|クラッシュ|スタート|並ん|追い/.test(text);
  const audioOn = audioState === "playing";
  const parts = text.split(/(スカーレット|コバルト|SCARLET|COBALT)/g);
  return <section className={`race-narration ${active ? "has-caption" : ""} ${exciting ? "is-exciting" : ""} ${text.length > 65 ? "has-long-caption" : ""} ${speaking ? "is-speaking" : ""}`} aria-label="AIレース実況">
    <div className="narrator-portrait" aria-hidden="true">
      <div className="narrator-orbit" /><span className="narrator-speedline one" /><span className="narrator-speedline two" />
      {imageFailed ? <Headphones className="narrator-fallback" /> : <img src="/images/commentator-hayate.png" alt="" onError={() => setImageFailed(true)} />}
      <span className="narrator-signature">PIT HAYATE</span>
    </div>
    <div className="narration-content">
      <div className="narration-topline">
        <div className="narrator-identity"><b>ピット・ハヤテ</b><span className={`narration-live ${live ? "is-live" : ""}`}><i />AI実況</span><span className="narration-engine">GPT-LIVE</span></div>
        <div className="narration-controls">
          <button type="button" disabled={preview} onClick={onToggleAudio} aria-pressed={audioOn} title="実況音声のオン・オフ。字幕は常に表示されます。">
            {audioOn ? <Volume2 size={14} /> : <VolumeX size={14} />}<span>{preview ? "表示サンプル" : audioOn ? "実況 ON" : audioState === "blocked" ? "音声を再開" : replay ? "最後の実況を聴く" : "実況を聴く"}</span>
          </button>
          {!preview && <label className="narration-volume"><span className="sr-only">実況の音量</span><input type="range" min="0" max="100" step="5" value={volume} aria-label="実況の音量" aria-valuetext={`${volume}%`} onChange={event => onVolumeChange?.(Number(event.currentTarget.value))} /></label>}
        </div>
      </div>
      <div className="narration-bubble" role="status" aria-live="polite" aria-atomic="true">
        <span className="narration-quote" aria-hidden="true">“</span>
        <p>{active ? parts.map((part, index) => <span key={index} className={/^(スカーレット|SCARLET)$/.test(part) ? "narration-scarlet" : /^(コバルト|COBALT)$/.test(part) ? "narration-cobalt" : undefined}>{part}</span>) : <span className="narration-idle">{status}</span>}</p>
        <span className="narration-energy" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      </div>
      <div className="narration-footnote"><span><AudioLines size={11} />{recorded ? "RECORDED SAMPLE" : preview ? "DESIGN PREVIEW" : speaking ? "ON AIR" : active ? "LIVE CAPTIONS" : "COMMENTARY BOX"}</span><span>{audioState === "unavailable" ? "このブラウザーでは字幕のみ表示" : "音声オフでも字幕で楽しめます"}</span></div>
    </div>
  </section>;
}
