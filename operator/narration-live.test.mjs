import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveNarrator, pcmToWav } from './live-narrator.mjs';

class FakeSocket extends EventEmitter {
  static sockets = [];
  constructor(url, options) {
    super(); this.url = url; this.options = options; this.readyState = 0; this.bufferedAmount = 0; this.sent = [];
    FakeSocket.sockets.push(this);
    setImmediate(() => { this.readyState = 1; this.emit('open'); });
  }
  send(raw) {
    const event = JSON.parse(raw); this.sent.push(event);
    if (event.type === 'session.start') setImmediate(() => this.receive({ type: 'session.started', session: { id: 'fixture' } }));
    if (event.type === 'session.close') setImmediate(() => this.receive({ type: 'session.closed', usage: { duration_seconds: 1 } }));
  }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(extra = {}) {
  const feeds = [], audio = [], logs = [];
  const narrator = createLiveNarrator({ key: 'fixture-key', raceId: 'race_fixture', WebSocketImpl: FakeSocket,
    publishAudio: async chunk => { audio.push(chunk); return `/audio/${chunk.seq}`; },
    publishFeed: async feed => feeds.push(feed), log: message => logs.push(message), finishGraceMs: 0,
    startTimeoutMs: 1000, closeTimeoutMs: 100, ...extra });
  return { narrator, feeds, audio, logs };
}

test('PCM uses a valid mono 24kHz WAV container', () => {
  const wav = pcmToWav(Buffer.alloc(48000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(40), 48000); assert.equal(wav.length, 48044);
});

test('session sends facts, receives real captions and shares bounded WAV chunks without keys in public feed', async () => {
  const { narrator, feeds, audio, logs } = fixture();
  await narrator.start();
  const socket = FakeSocket.sockets.at(-1);
  assert.equal(socket.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(socket.options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(socket.sent[0].session.audio.format.rate, 24000);
  assert.equal(socket.sent[0].session.delegation.type, 'client');
  narrator.observe({ updatedAt: Date.now(), startedAt: Date.now(), phase: 'racing', course: { length: 200 }, history: [], players: { red: { progress: 0 }, blue: { progress: 0 } } });
  assert.ok(socket.sent.some(event => event.type === 'session.commentary.append' && event.content.includes('スタート')));
  socket.receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') });
  socket.receive({ type: 'session.output_transcript.delta', delta: '行け、', start_ms: 0, end_ms: 300 });
  socket.receive({ type: 'session.output_transcript.delta', delta: 'スカーレット！', start_ms: 300, end_ms: 1200 });
  await pause(220);
  assert.equal(audio.length, 1); assert.equal(audio[0].durationMs, 1000);
  assert.equal(feeds.at(-1).captions[0].text, '行け、スカーレット！');
  assert.equal(feeds.at(-1).captions[0].endMs, 1200);
  assert.ok(socket.sent.some(event => event.type === 'session.input_audio.append'));
  assert.ok(!JSON.stringify(feeds).includes('fixture-key')); assert.ok(!JSON.stringify(logs).includes('fixture-key'));
  const summary = await narrator.finish();
  assert.equal(summary.finalized, true); assert.equal(summary.status, 'ended'); assert.equal(summary.transcriptFragments, 2);
  assert.equal(socket.sent.filter(event => event.type === 'session.close').length, 1);
  await narrator.finish(); assert.equal(socket.sent.filter(event => event.type === 'session.close').length, 1);
});

test('provider failure isolates narration, publishes safe error, and releases session', async () => {
  const { narrator, feeds, logs } = fixture();
  await narrator.start(); const socket = FakeSocket.sockets.at(-1);
  socket.receive({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'DO NOT EXPOSE fixture-key' } });
  const result = await narrator.finish({ cancelled: true });
  assert.equal(result.status, 'error'); assert.equal(result.error, 'rate_limit_exceeded');
  assert.ok(!JSON.stringify(feeds).includes('DO NOT EXPOSE')); assert.ok(!JSON.stringify(logs).includes('fixture-key'));
  assert.equal(socket.readyState, 3);
});

test('slow publishers cannot indefinitely block cancellation', async () => {
  const { narrator } = fixture({ publishAudio: () => new Promise(() => {}), uploadTimeoutMs: 30 });
  await narrator.start(); FakeSocket.sockets.at(-1).receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') });
  const before = Date.now(); await narrator.finish({ cancelled: true });
  assert.ok(Date.now() - before < 500);
});

test('terminal feed waits for final WAV and finish waits for terminal write acknowledgment', async () => {
  let releaseAudio, releaseFinal, terminalFeed;
  let finished = false;
  const { narrator } = fixture({ uploadTimeoutMs: 300,
    publishAudio: () => new Promise(resolve => { releaseAudio = () => resolve('/audio/final'); }),
    publishFeed: async feed => {
      if (feed.status === 'ended') {
        terminalFeed = feed;
        await new Promise(resolve => { releaseFinal = resolve; });
      }
    },
  });
  await narrator.start(); const socket = FakeSocket.sockets.at(-1);
  socket.receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(24000).toString('base64') });
  socket.receive({ type: 'session.output_transcript.delta', delta: 'コバルト、ゴール！', start_ms: 0, end_ms: 500 });
  const finishing = narrator.finish({ cancelled: true }).then(value => { finished = true; return value; });
  await pause(30);
  assert.equal(terminalFeed, undefined); assert.equal(finished, false);
  releaseAudio(); await pause(40);
  assert.equal(terminalFeed.chunks[0].url, '/audio/final');
  assert.equal(terminalFeed.captions[0].text, 'コバルト、ゴール！');
  assert.equal(finished, false);
  releaseFinal(); const result = await finishing;
  assert.equal(result.finalFeedPublished, true); assert.equal(result.finalized, true);
});

test('late timed-out feed cannot overwrite terminal state in a revision-enforcing store', async () => {
  let releaseOld, stored;
  const attempts = [];
  const { narrator } = fixture({ uploadTimeoutMs: 25,
    publishFeed: async feed => {
      attempts.push(feed.revision);
      if (feed.revision === 1) await new Promise(resolve => { releaseOld = resolve; });
      // Mirrors the hosted endpoint's conditional revision write.
      if (!stored || stored.revision < feed.revision) stored = feed;
    },
  });
  await narrator.start(); const result = await narrator.finish({ cancelled: true });
  assert.equal(result.finalFeedPublished, true); assert.equal(stored.status, 'ended');
  const finalRevision = stored.revision;
  releaseOld(); await pause(10);
  assert.equal(stored.revision, finalRevision); assert.equal(stored.status, 'ended');
  assert.ok(attempts.every((revision, index) => !index || revision > attempts[index - 1]));
});

test('unresponsive terminal feed is bounded and reports publication failure', async () => {
  const { narrator } = fixture({ uploadTimeoutMs: 15, publishFeed: () => new Promise(() => {}) });
  await narrator.start(); const before = Date.now(); const result = await narrator.finish({ cancelled: true });
  assert.ok(Date.now() - before < 250);
  assert.equal(result.status, 'error'); assert.equal(result.error, 'final_feed_publish_failed');
  assert.equal(result.finalFeedPublished, false);
});
