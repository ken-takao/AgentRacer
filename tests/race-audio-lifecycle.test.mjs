import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual components, replacing only browser/React boundaries. The
// small hook host preserves refs, effect dependencies and cleanup across renders.
// No network, real audio device, timers, or AI sessions are needed.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function harness(kind, { contextState = 'suspended', feed = null } = {}) {
  let now = 0, hookIndex = 0, controller;
  const hooks = [], effects = [], intervals = new Set(), contexts = [], statuses = [];
  const resumeAttempts = [], playAttempts = [];
  const media = {
    muted: true, volume: 1, paused: true, currentTime: 0, error: null,
    play() { this.paused = false; const attempt = deferred(); playAttempts.push(attempt); return attempt.promise; },
    pause() { this.paused = true; }, load() {},
  };
  class FakeAudioContext {
    state = contextState; destination = {}; onstatechange = null; sources = [];
    constructor() { contexts.push(this); }
    get currentTime() { return now / 1000; }
    createGain() {
      return this.gainNode = { gain: { value: 0, setTargetAtTime(value) { this.value = value; } }, connect() {} };
    }
    resume() { const attempt = deferred(); resumeAttempts.push(attempt); return attempt.promise; }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 2 }); }
    createBufferSource() {
      const source = {
        buffer: null, state: 'new', onended: null, connect() {}, disconnect() {},
        start(when, offset) { this.state = 'started'; this.when = when; this.offset = offset; },
        stop() { this.state = 'stopped'; },
      };
      this.sources.push(source);
      return source;
    }
  }
  const soundChannel = {
    register(value) {
      controller = value;
      value.setVolume(kind === 'bgm' ? 45 : 90);
      value.setEnabled(true);
      return () => { if (controller === value) controller = null; };
    },
    reportStatus(value) { statuses.push(value); },
  };
  const react = {
    useRef(value) { const index = hookIndex++; return hooks[index] ??= { current: value }; },
    useState(value) {
      const index = hookIndex++;
      hooks[index] ??= { value: typeof value === 'function' ? value() : value };
      return [hooks[index].value, value => { hooks[index].value = value; }];
    },
    useCallback(callback, deps) {
      const index = hookIndex++;
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { callback, deps };
      return hooks[index].callback;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!sameDeps(hooks[index]?.deps, deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  const jsx = (type, props) => {
    if (type === 'audio') props.ref.current = media;
    return { type, props };
  };
  const module = { exports: {} };
  const filename = kind === 'bgm' ? 'race-audio' : 'race-narration';
  const source = readFileSync(new URL(`../app/${filename}.tsx`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const require = name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './race-sound') return { useRaceSoundChannel: () => soundChannel };
    if (name === 'lucide-react' || name.endsWith('.css')) return {};
    throw new Error(`Unexpected component dependency: ${name}`);
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require, DOMException, AbortController, AbortSignal, URL,
    window: { AudioContext: FakeAudioContext, location: { origin: 'https://race.test' } },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    performance: { now: () => now },
    fetch: async url => {
      if (!feed) return new Promise(() => {});
      if (url.toString().endsWith('/narration')) return {
        ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => feed,
      };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    },
    setInterval(callback) { intervals.add(callback); return callback; },
    clearInterval(callback) { intervals.delete(callback); }, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  const component = kind === 'bgm' ? module.exports.RaceAudio : module.exports.RaceNarration({ raceId: 'fixture' }).type;
  return {
    media, contexts, statuses, playAttempts, resumeAttempts,
    get controller() { return controller; },
    render(props = {}) {
      hookIndex = 0;
      component({ raceId: 'fixture', ...props });
      effects.splice(0).forEach(effect => effect());
    },
    async tick(at) {
      now = at;
      for (const context of contexts) for (const source of context.sources) {
        if (source.state === 'started' && now / 1000 >= source.when + source.buffer.duration - source.offset) {
          source.state = 'ended'; source.onended?.();
        }
      }
      intervals.forEach(callback => callback());
      await flush();
    },
    unmount() { for (const hook of [...hooks].reverse()) hook?.cleanup?.(); },
  };
}

test('narration exposes a pending autoplay block and cannot unmute after OFF', async () => {
  const h = harness('narration'); h.render();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.statuses.at(-1), 'blocked');
  h.controller.setEnabled(false);
  const context = h.contexts[0];
  context.state = 'running'; context.onstatechange?.();
  h.resumeAttempts[0].resolve(); await flush();
  assert.equal(context.gainNode.gain.value, 0);
  assert.equal(h.statuses.at(-1), 'ready');
  h.controller.setEnabled(true);
  assert.equal(context.gainNode.gain.value, .9);
  h.controller.setVolume(35);
  assert.equal(context.gainNode.gain.value, .35);
  h.unmount();
});

test('narration ignores resume completion after unmount', async () => {
  const h = harness('narration'); h.render();
  h.unmount();
  const statuses = [...h.statuses];
  h.resumeAttempts[0].resolve(); await flush();
  assert.equal(h.contexts[0].state, 'closed');
  assert.deepEqual(h.statuses, statuses);
});

const sampleFeed = status => ({
  version: 1, raceId: 'fixture', generationId: 'recording', status, startedAt: 0, updatedAt: 0,
  chunks: [{ seq: 1, url: '/audio/recorded.wav', startMs: 0, durationMs: 2000 }],
  captions: [{ id: 'caption', text: 'スタートしました', startMs: 0, endMs: 2000 }],
});

test('narration cancels scheduled sources on mute and schedules one replacement after ON', async () => {
  const h = harness('narration', { contextState: 'running', feed: sampleFeed('live') });
  h.render(); await flush(); await h.tick(0);
  const context = h.contexts[0];
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].state, 'started');
  h.controller.setEnabled(false);
  assert.equal(context.sources[0].state, 'stopped');
  h.controller.setEnabled(true); await h.tick(100);
  assert.equal(context.sources.length, 2, 'cleared scheduled set allows the cancelled chunk to resume');
  assert.equal(context.sources.filter(source => source.state === 'started').length, 1);
  h.unmount();
});

test('completed narration drains once without muting the preference or automatically replaying', async () => {
  const h = harness('narration', { contextState: 'running', feed: sampleFeed('ended') });
  h.render(); await flush(); await h.tick(0); await h.tick(1500);
  assert.equal(h.statuses.at(-1), 'playing');
  await h.tick(4000); await h.tick(7000);
  assert.equal(h.statuses.at(-1), 'ready');
  assert.equal(h.contexts[0].sources.length, 1);
  assert.equal(h.contexts[0].gainNode.gain.value, .9);
  h.controller.setEnabled(false); h.controller.setEnabled(true); await h.tick(7000);
  assert.equal(h.contexts[0].sources.length, 2, 'an explicit OFF/ON can replay retained final narration');
  h.unmount();
});

test('BGM pending play cannot revive after mute or unmount', async () => {
  const h = harness('bgm'); h.render({ phase: 'racing' });
  assert.equal(h.media.volume, .45);
  h.controller.setEnabled(false);
  h.playAttempts[0].resolve(); await flush();
  assert.equal(h.media.muted, true); assert.equal(h.media.paused, true);
  assert.equal(h.statuses.at(-1), 'ready');
  h.controller.setEnabled(true);
  h.unmount();
  const statuses = [...h.statuses];
  h.playAttempts[1].resolve(); await flush();
  assert.equal(h.media.muted, true); assert.equal(h.media.paused, true);
  assert.deepEqual(h.statuses, statuses);
});

test('BGM is silent during lobby/countdown, audible during racing, and stops on finish', async () => {
  const h = harness('bgm');
  for (const phase of ['lobby', 'countdown']) {
    h.render({ phase }); assert.equal(h.media.muted, true);
    h.playAttempts.at(-1).resolve(); await flush();
    assert.equal(h.media.paused, true); assert.equal(h.statuses.at(-1), 'ready');
  }
  h.render({ phase: 'racing' }); h.playAttempts.at(-1).resolve(); await flush();
  assert.equal(h.media.muted, false); assert.equal(h.media.paused, false);
  assert.equal(h.statuses.at(-1), 'playing');
  h.render({ phase: 'finished' }); assert.equal(h.media.muted, true);
  h.playAttempts.at(-1).resolve(); await flush();
  assert.equal(h.media.paused, true); assert.equal(h.statuses.at(-1), 'ready');
  h.unmount();
});

test('BGM stale play rejection cannot overwrite a newer successful race playback', async () => {
  const h = harness('bgm'); h.render({ phase: 'lobby' });
  h.render({ phase: 'racing' });
  h.playAttempts[1].resolve(); await flush();
  h.playAttempts[0].reject(new DOMException('Gesture required', 'NotAllowedError')); await flush();
  assert.equal(h.statuses.at(-1), 'playing');
  assert.equal(h.media.muted, false); assert.equal(h.media.paused, false);
  h.unmount();
});
