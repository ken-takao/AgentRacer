import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createNarrationDirector, NARRATOR_INSTRUCTIONS } from './narration-director.mjs';

export const LIVE_SAMPLE_RATE = 24000;
const BYTES_PER_MS = LIVE_SAMPLE_RATE * 2 / 1000;

/** Plan silence against elapsed time, not the number of timer callbacks. */
export function planSilentInput(elapsedMs, sentFrames) {
  if (!Number.isFinite(elapsedMs) || !Number.isSafeInteger(sentFrames) || sentFrames < 0) throw new RangeError('invalid_audio_clock');
  const targetFrames = Math.floor(Math.max(0, elapsedMs) * LIVE_SAMPLE_RATE / 1000);
  const owedFrames = Math.max(0, targetFrames - sentFrames);
  // A suspended process must not fast-forward a long, stale session on resume.
  if (owedFrames > LIVE_SAMPLE_RATE * 10) throw new RangeError('audio_input_clock_lag');
  // At most one second of catch-up per tick, in packets no larger than 500 ms.
  let remaining = Math.min(owedFrames, LIVE_SAMPLE_RATE);
  const packets = [];
  while (remaining) {
    const frames = Math.min(remaining, LIVE_SAMPLE_RATE / 2);
    packets.push(frames); remaining -= frames;
  }
  return packets;
}

export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(LIVE_SAMPLE_RATE, 24); header.writeUInt32LE(LIVE_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}

/** One GPT-Live session per race. All keys stay inside this operator process. */
export function createLiveNarrator({
  key, raceId, publishAudio, publishFeed, log = () => {}, voice = 'marin',
  WebSocketImpl = WebSocket, now = Date.now, monotonicClock = () => performance.now(), startTimeoutMs = 20000,
  closeTimeoutMs = 10000, finishGraceMs = 6500, maxDurationMs = 300000,
  uploadTimeoutMs = 6000, chunkMs = 1000, tailMs = 60000,
} = {}) {
  if (!raceId || typeof publishAudio !== 'function' || typeof publishFeed !== 'function') throw new TypeError('Narrator requires raceId and publishers');
  chunkMs = Math.min(1500, Math.max(200, chunkMs));
  tailMs = Math.min(90000, Math.max(30000, tailMs));
  const generationId = randomUUID();
  const director = createNarrationDirector({ now });
  const feed = { version: 1, revision: 0, raceId, generationId, status: 'connecting', voice, sampleRate: LIVE_SAMPLE_RATE, startedAt: now(), updatedAt: now(), chunks: [], captions: [] };
  let socket, startPromise, finishPromise, resolveStarted, rejectStarted, resolveClosed;
  let startTimer, inputTimer, tickTimer, maxTimer, closeTimer, feedTimer;
  let didStart = false, closing = false, closed = false, finalized = false, finishRequested = false;
  let pendingPcm = Buffer.alloc(0), outputCursor = 0, outputInitialized = false, seq = 0, captionId = 0;
  let uploadQueue = [], uploading = false, latestFeed = null, publishingFeed = false;
  let finalizationPromise = null, uploadsSealed = false, terminalPublishing = false, finalFeedPublished = null;
  let firstAudioAt = null, firstTranscriptAt = null, lastOutputAt = null, lastContextAt = 0;
  let receivedBytes = 0, droppedChunks = 0, sentFacts = 0, transcriptFragments = 0;
  let inputFrames = 0, inputClockStartedAt = null;
  let errorCode = null, usage = null, observeState = null;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
  const safeLog = text => { try { log(text); } catch {} };
  const clearTimers = () => {
    clearTimeout(startTimer); clearTimeout(maxTimer); clearTimeout(closeTimer); clearTimeout(feedTimer);
    clearInterval(inputTimer); clearInterval(tickTimer);
  };
  const send = event => {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(event)); return true; } catch { fail('transport_error'); return false; }
  };
  function trim() {
    const end = Math.max(outputCursor, now() - feed.startedAt);
    feed.chunks = feed.chunks.filter(c => c.startMs + c.durationMs >= end - tailMs).slice(-100);
    feed.captions = feed.captions.filter(c => c.endMs >= end - tailMs).slice(-150);
  }
  function publish({ terminal = false } = {}) {
    if (terminalPublishing && !terminal) return Promise.resolve(false);
    trim(); feed.updatedAt = now(); feed.revision++;
    // An intermediate snapshot can be coalesced, but every caller has a bounded
    // completion result. Remote stores must reject stale revisions: a timed-out
    // write may still complete after a newer write reaches the server.
    latestFeed?.resolve(false);
    const result = new Promise(resolve => { latestFeed = { value: structuredClone(feed), resolve }; });
    if (publishingFeed) return result;
    publishingFeed = true;
    void (async () => {
      try {
        while (latestFeed) {
          const job = latestFeed; latestFeed = null;
          try {
            await bounded(Promise.resolve().then(() => publishFeed(job.value)), uploadTimeoutMs, 'feed_timeout');
            job.resolve(true);
          } catch {
            safeLog('実況データの配信が遅れています。次の更新で再試行します。');
            job.resolve(false);
          }
        }
      } finally { publishingFeed = false; }
    })();
    return result;
  }
  function schedulePublish() {
    if (feedTimer) return;
    feedTimer = setTimeout(() => { feedTimer = null; publish(); }, 180);
  }
  function fail(code) {
    if (closed || errorCode) return;
    errorCode = code; feed.status = 'error'; feed.error = code;
    safeLog(`実況を停止しました (${code})。レースの操作は継続します。`);
    rejectStarted?.(new Error(`GPT-Live narrator: ${code}`));
    publish();
    void closeSession();
  }
  async function pumpUploads() {
    if (uploading) return;
    uploading = true;
    try {
      while (uploadQueue.length && !uploadsSealed) {
        const chunk = uploadQueue.shift();
        const url = await bounded(Promise.resolve().then(() => publishAudio(chunk)), uploadTimeoutMs, 'audio_upload_timeout');
        if (uploadsSealed) break;
        if (typeof url !== 'string' || !url) throw new Error('invalid_audio_url');
        feed.chunks.push({ seq: chunk.seq, url, startMs: chunk.startMs, durationMs: chunk.durationMs });
        publish();
      }
    } catch {
      uploadQueue = [];
      if (closed && !uploadsSealed) { errorCode ||= 'audio_publish_failed'; feed.error = errorCode; }
      else if (uploadsSealed) return;
      else fail('audio_publish_failed');
    } finally { uploading = false; }
  }
  function queueAudio(pcm) {
    if (!pcm.length || uploadsSealed) return;
    const durationMs = pcm.length / BYTES_PER_MS;
    const chunk = { generationId, seq: seq++, buffer: pcmToWav(pcm), contentType: 'audio/wav', startMs: outputCursor, durationMs };
    outputCursor += durationMs;
    // Bound memory and lag. Never let a slow object store grow an unbounded queue.
    if (uploadQueue.length >= 8) { uploadQueue.shift(); droppedChunks++; }
    uploadQueue.push(chunk); void pumpUploads();
  }
  function flushAudio() {
    const length = pendingPcm.length - pendingPcm.length % 2;
    if (length) queueAudio(pendingPcm.subarray(0, length));
    pendingPcm = Buffer.alloc(0);
  }
  function receiveAudio(delta) {
    if (typeof delta !== 'string' || delta.length > 4_000_000) return;
    const pcm = Buffer.from(delta, 'base64');
    if (!pcm.length) return;
    if (firstAudioAt === null) firstAudioAt = now();
    lastOutputAt = now(); receivedBytes += pcm.length;
    if (!outputInitialized) {
      // WS emits one ordered, continuous output sample stream beginning at zero.
      // Arrival latency is not part of that stream or the transcript timestamps.
      outputCursor = 0;
      outputInitialized = true;
    }
    pendingPcm = Buffer.concat([pendingPcm, pcm]);
    const bytes = Math.round(chunkMs * BYTES_PER_MS / 2) * 2;
    while (pendingPcm.length >= bytes) {
      queueAudio(pendingPcm.subarray(0, bytes)); pendingPcm = pendingPcm.subarray(bytes);
    }
  }
  function receiveCaption(event) {
    if (typeof event.delta !== 'string' || !event.delta || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return;
    if (event.start_ms < 0 || event.end_ms < event.start_ms) return;
    if (firstTranscriptAt === null) firstTranscriptAt = now();
    transcriptFragments++;
    // No synthetic fallback captions: these are exactly the model's spoken text.
    const last = feed.captions.at(-1);
    if (last && event.start_ms >= last.startMs && event.start_ms - last.endMs <= 1100 && last.text.length < 90 && !/[。！？!?]$/.test(last.text)) {
      last.text += event.delta; last.endMs = Math.max(last.endMs, event.end_ms);
    } else feed.captions.push({ id: `${generationId}:${captionId++}`, text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
    schedulePublish();
  }
  function tick() {
    if (!didStart || closing || closed) return;
    const fact = director.next();
    if (fact && send({ type: 'session.commentary.append', event_id: `fact_${generationId}_${sentFacts++}`, delegation_id: null, content: fact.text })) {
      safeLog(`実況イベント: ${fact.kind}`);
    }
    // Short packet bursts can end below one chunk. Release these promptly.
    if (pendingPcm.length && lastOutputAt !== null && now() - lastOutputAt > 300) flushAudio();
  }
  function observe(state) {
    observeState = state;
    if (finishRequested || closed || errorCode) return;
    director.observe(state);
    if (didStart && now() - lastContextAt > 8000 && state?.players?.red && state?.players?.blue) {
      lastContextAt = now();
      const red = state.players.red, blue = state.players.blue;
      const facts = `背景情報。これは読み上げず、次の実況情報を待つ。現在の状態: ${state.phase}。スカーレット進行${Math.round(red.progress)}、コバルト進行${Math.round(blue.progress)}、コース全長${state.course?.length ?? 200}。進行の単位はゲーム内距離。`;
      send({ type: 'session.thinking.append', event_id: `state_${generationId}_${now()}`, delegation_id: null, content: facts });
    }
    tick();
  }
  async function closeSession() {
    if (closed) return;
    if (!closing) {
      closing = true; clearInterval(inputTimer); clearInterval(tickTimer); clearTimeout(maxTimer); clearTimeout(startTimer);
      flushAudio();
      if (didStart && socket?.readyState === 1) {
        send({ type: 'session.close', event_id: `close_${generationId}` });
        closeTimer = setTimeout(() => {
          errorCode ||= 'close_timeout'; feed.error = errorCode;
          socket?.terminate?.(); completeClose(false);
        }, closeTimeoutMs);
      } else {
        socket?.terminate?.(); completeClose(false);
      }
    }
    await closedPromise;
  }
  function completeClose(wasFinalized) {
    if (closed) return;
    finalized ||= wasFinalized; closed = true; clearTimers(); flushAudio();
    rejectStarted?.(new Error('GPT-Live narrator closed before ready'));
    // Transport finalization does not mean the final audio objects are stored.
    // Keep the public feed open until all accepted PCM has had a bounded drain.
    finalizationPromise = finalizeFeed();
    resolveClosed();
  }
  async function finalizeFeed() {
    const deadline = Date.now() + uploadTimeoutMs + 1000;
    while ((uploading || uploadQueue.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (uploading || uploadQueue.length) {
      errorCode ||= 'audio_drain_timeout'; feed.error = errorCode;
      droppedChunks += uploadQueue.length;
    }
    uploadsSealed = true; uploadQueue = []; terminalPublishing = true;
    clearTimeout(feedTimer); feedTimer = null;
    feed.status = errorCode ? 'error' : 'ended';
    finalFeedPublished = await publish({ terminal: true });
    if (!finalFeedPublished) {
      errorCode ||= 'final_feed_publish_failed'; feed.error = errorCode; feed.status = 'error';
      // One bounded final error publication; do not keep cleanup alive forever.
      finalFeedPublished = await publish({ terminal: true });
    }
  }
  function start() {
    if (startPromise) return startPromise;
    if (closed || closing) return Promise.reject(new Error('GPT-Live narrator is already closed'));
    startPromise = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    // observe() remains nonblocking even if the caller elects not to await start.
    startPromise.catch(() => {});
    publish();
    if (typeof key !== 'string' || !key.trim()) { fail('missing_api_key'); return startPromise; }
    try {
      socket = new WebSocketImpl('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: startTimeoutMs });
      startTimer = setTimeout(() => fail('start_timeout'), startTimeoutMs);
      socket.on('open', () => {
        if (closing || closed) return;
        send({ type: 'session.start', event_id: `start_${generationId}`, session: {
          model: 'gpt-live-1', instructions: NARRATOR_INSTRUCTIONS,
          audio: { format: { type: 'audio/pcm', rate: LIVE_SAMPLE_RATE }, output: { voice } },
          delegation: { type: 'client' }, store: false,
          input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '日本語で「AI実況、ピット・ハヤテです」と一度だけ挨拶し、直ちに黙って実況情報を待つ。まだレースが開始したとは言わない。' }] }],
        } });
      });
      socket.on('message', raw => {
        if (closed) return;
        let event;
        try { event = JSON.parse(raw.toString()); } catch { fail('invalid_server_event'); return; }
        if (event.type === 'session.started' && !didStart) {
          didStart = true; clearTimeout(startTimer); feed.status = 'live'; feed.startedAt = now(); publish();
          safeLog('GPT-Live 実況セッションが開始しました。');
          // A delayed callback must catch up the input timeline rather than lose
          // its missed 100 ms intervals forever. The wall clock can jump; use a
          // monotonic clock, complete PCM frames, and bounded catch-up packets.
          inputClockStartedAt = monotonicClock();
          inputTimer = setInterval(() => {
            if (closing || closed) return;
            let packets;
            try { packets = planSilentInput(monotonicClock() - inputClockStartedAt, inputFrames); }
            catch { fail('audio_input_clock_lag'); return; }
            for (const frames of packets) {
              if (socket.bufferedAmount > 48000 * 3) { fail('audio_input_backpressure'); return; }
              if (!send({ type: 'session.input_audio.append', audio: Buffer.alloc(frames * 2).toString('base64') })) return;
              inputFrames += frames;
            }
          }, 100);
          inputTimer.unref?.();
          tickTimer = setInterval(tick, 200); tickTimer.unref?.();
          maxTimer = setTimeout(() => { safeLog('実況の最大実行時間に達しました。'); void finish({ cancelled: true }); }, maxDurationMs);
          maxTimer.unref?.();
          resolveStarted(); tick();
        } else if (event.type === 'session.output_audio.delta') receiveAudio(event.delta);
        else if (event.type === 'session.output_transcript.delta') receiveCaption(event);
        else if (event.type === 'session.closed') { usage = event.usage ?? null; finalized = true; completeClose(true); socket.close(); }
        else if (event.type === 'session.delegation.created') {
          // Narration is driven by this server's facts, never an unbounded extra model/tool call.
          send({ type: 'session.thinking.append', event_id: `local_${generationId}_${now()}`, delegation_id: event.delegation?.id ?? null, content: '外部の作業は不要。ゲームサーバーから届く次の実況情報を待つ。' });
        } else if (event.type === 'error') {
          // Log a bounded enum only: provider messages can contain request context.
          const code = String(event.error?.code || 'api_error').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 70);
          if (!closing) fail(code || 'api_error');
        }
      });
      socket.on('error', () => fail('connection_error'));
      socket.on('close', () => {
        if (!closed) {
          errorCode ||= closing ? 'closed_without_finalization' : 'connection_closed';
          feed.error = errorCode;
          completeClose(false);
        }
      });
    } catch { fail('connection_error'); }
    return startPromise;
  }
  function finish({ cancelled = false } = {}) {
    if (finishPromise) return finishPromise;
    finishRequested = true;
    finishPromise = (async () => {
      if (!closing && !closed && didStart && !errorCode) {
        if (cancelled) director.clear();
        else if (observeState) { director.observe(observeState); tick(); }
        if (!cancelled) await new Promise(resolve => setTimeout(resolve, finishGraceMs));
      }
      await closeSession();
      await finalizationPromise;
      return status();
    })();
    return finishPromise;
  }
  function status() {
    return { generationId, revision: feed.revision, status: feed.status, voice, startedAt: feed.startedAt, finalized, finalFeedPublished, error: errorCode,
      firstAudioMs: firstAudioAt === null ? null : firstAudioAt - feed.startedAt,
      firstTranscriptMs: firstTranscriptAt === null ? null : firstTranscriptAt - feed.startedAt,
      audioMs: Math.round(receivedBytes / BYTES_PER_MS), inputAudioMs: Math.round(inputFrames * 1000 / LIVE_SAMPLE_RATE),
      transcriptFragments, sentFacts, chunks: seq, droppedChunks, usage };
  }
  return { start, observe, finish, status };
}
