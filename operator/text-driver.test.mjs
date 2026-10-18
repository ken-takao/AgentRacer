import test from 'node:test';
import assert from 'node:assert/strict';
import { runTextDriver } from './text-driver.mjs';

const SECRET = 'private-key-and-hidden-state';
const player = overrides => ({ progress: 20, lane: 1, targetLane: 1, speedMode: 'normal', speed: 1.8,
  joined: true, ready: true, jumpAvailable: true, upcomingObstacles: [], routeChoices: {}, ...overrides });
const route = (id, start = 40, end = 70) => ({ id, start, end, defaultRoute: 'right', routes: {
  left: { speedMultiplier: 1.1, blockedLanes: [1] }, right: { speedMultiplier: 1, blockedLanes: [] },
} });
const state = (phase = 'racing') => ({ phase, version: 2, updatedAt: 10000, token: SECRET,
  course: { length: 200, junctions: [route('fork1'), route('fork2', 120, 160)], obstacles: [{ progress: 190, secret: SECRET }] },
  players: { red: player(), blue: player({ progress: 29, lane: 2 }) }, history: [{ secret: SECRET }] });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  let time = 10000, reads = 0;
  const trace = [], errors = [], decisions = [], sleeps = [], executions = [];
  const controller = new AbortController();
  const api = {
    color: 'red', key: SECRET, signal: controller.signal, now: () => time,
    readState: async () => { const observedAt = time; time += 10; return { state: state(++reads >= 3 ? 'finished' : 'racing'), observedAt }; },
    decide: async () => { time += 100; return { action: 'lane_left', observedAt: time - 110, instruction: 'Click LEFT once.' }; },
    execute: async input => { executions.push(input); time += 25; },
    onDecision: value => decisions.push(value), onTrace: value => trace.push(value), onError: value => errors.push(value),
    sleep: async ms => { sleeps.push(ms); time += ms; }, ...overrides,
  };
  return { api, controller, trace, errors, decisions, sleeps, executions, advance: ms => { time += ms; }, time: () => time };
}

test('performs one visible action with fresh revalidation and timing-only trace', async () => {
  const f = fixture();
  assert.deepEqual(await runTextDriver(f.api), { reason: 'terminal', iterations: 1, executed: 1 });
  assert.equal(f.executions.length, 1);
  const command = f.executions[0];
  assert.deepEqual(command.input, { type: 'lane', lane: 0 });
  assert.equal(command.observation.observedAt, 10110);
  assert.equal(command.trace.observedAt, 10000);
  assert.equal(command.trace.dispatchAgeMs, 120);
  assert.equal(command.signal, f.controller.signal);
  assert.equal(f.trace[0].executeMs, 25);
  assert.ok(!JSON.stringify(f.trace).includes(SECRET));
  assert.ok(!JSON.stringify(command.observation).includes(SECRET));
  assert.ok(Object.values(f.trace[0]).every(value => typeof value === 'number'));
});

test('serializes decisions, actions and state reads rather than queueing old commands', async () => {
  const action = defer(), entered = defer(); let readCount = 0, decisions = 0;
  const f = fixture({ readState: async () => { readCount++; return { state: state(readCount >= 3 ? 'finished' : 'racing'), observedAt: 10000 }; },
    decide: async () => { decisions++; return { action: 'lane_left' }; },
    execute: async () => { entered.resolve(); await action.promise; } });
  const running = runTextDriver(f.api);
  await entered.promise;
  assert.equal(readCount, 2); assert.equal(decisions, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(readCount, 2); assert.equal(decisions, 1);
  action.resolve();
  assert.equal((await running).executed, 1);
});

test('wait sleeps 750ms and then fetches a new observation without executing', async () => {
  let reads = 0;
  const f = fixture({ readState: async () => ({ state: state(++reads === 1 ? 'racing' : 'finished'), observedAt: 10000 }),
    decide: async () => ({ action: 'wait' }) });
  assert.equal((await runTextDriver(f.api)).executed, 0);
  assert.deepEqual(f.sleeps, [750]); assert.equal(reads, 2);
  assert.equal(f.trace[0].skipReason, 'wait');
});

test('rejects same settings initially or after revalidation without issuing a click', async () => {
  for (const changedAfterDecision of [false, true]) {
    let reads = 0;
    const f = fixture({ readState: async () => {
      const s = state(++reads > (changedAfterDecision ? 2 : 1) ? 'finished' : 'racing');
      if (changedAfterDecision && reads === 2) s.players.red.targetLane = 0;
      return { state: s, observedAt: 10000 };
    }, decide: async () => ({ action: changedAfterDecision ? 'lane_left' : 'lane_center' }) });
    assert.equal((await runTextDriver(f.api)).executed, 0);
    assert.equal(f.trace[0].skipReason, 'same_setting');
  }
});

test('skips expired decisions including time spent publishing and revalidating', async () => {
  for (const delayedStage of ['decision', 'onDecision', 'revalidation']) {
    let reads = 0;
    const f = fixture();
    f.api.readState = async () => {
      const observedAt = f.time(); reads++;
      if (delayedStage === 'revalidation' && reads === 2) f.advance(3001);
      return { state: state(reads > (delayedStage === 'revalidation' ? 2 : 1) ? 'finished' : 'racing'), observedAt };
    };
    f.api.decide = async () => { if (delayedStage === 'decision') f.advance(3001); return { action: 'lane_left' }; };
    f.api.onDecision = () => { if (delayedStage === 'onDecision') f.advance(3001); };
    assert.equal((await runTextDriver(f.api)).executed, 0);
    assert.equal(f.trace[0].skipReason, 'expired');
  }
});

test('does not use a stale first read or call the model before fresh observation', async () => {
  let reads = 0, decisions = 0;
  const f = fixture({ readState: async () => ({ state: state(++reads === 1 ? 'racing' : 'finished'), observedAt: 7000 }),
    decide: async () => { decisions++; return { action: 'lane_left' }; } });
  assert.equal((await runTextDriver(f.api)).iterations, 0);
  assert.equal(decisions, 0); assert.equal(f.trace[0].skipReason, 'expired');
});

test('route decisions are discarded when locked or when the next fork replaces the first', async () => {
  for (const changedFork of [false, true]) {
    let reads = 0;
    const f = fixture({ readState: async () => {
      const s = state(++reads > 2 ? 'finished' : 'racing');
      if (reads === 2) s.players.red.progress = changedFork ? 80 : 40;
      return { state: s, observedAt: 10000 };
    }, decide: async () => ({ action: 'route_left' }) });
    assert.equal((await runTextDriver(f.api)).executed, 0);
    assert.equal(f.trace[0].skipReason, changedFork ? 'route_changed' : 'route_locked');
  }
});

test('permits preparation controls while lobby and countdown are active', async () => {
  for (const phase of ['lobby', 'countdown']) {
    let reads = 0;
    const f = fixture({ readState: async () => ({ state: state(++reads > 2 ? 'finished' : phase), observedAt: 10000 }),
      decide: async () => ({ action: 'speed_turbo' }) });
    assert.equal((await runTextDriver(f.api)).executed, 1);
    assert.deepEqual(f.executions[0].input, { type: 'speed', speed: 'turbo' });
  }
});

test('three consecutive API failures stop without leaking underlying error bodies', async () => {
  const f = fixture({ readState: async () => ({ state: state(), observedAt: f.time() }),
    decide: async () => { throw Object.assign(new Error(SECRET), { code: SECRET }); } });
  await assert.rejects(runTextDriver(f.api), error => error.code === 'decision_failed' && !String(error).includes(SECRET));
  assert.deepEqual(f.errors.map(error => error.consecutiveFailures), [1, 2, 3]);
  assert.deepEqual(f.sleeps, [750, 750]);
  assert.equal(f.executions.length, 0);
  assert.ok(!JSON.stringify([f.errors, f.trace]).includes(SECRET));
});

test('a successful wait resets consecutive API failure count', async () => {
  let attempts = 0;
  const f = fixture({ readState: async () => ({ state: state(attempts >= 6 ? 'finished' : 'racing'), observedAt: f.time() }),
    decide: async () => { if (++attempts % 3) throw new Error(SECRET); return { action: 'wait' }; } });
  assert.equal((await runTextDriver(f.api)).reason, 'terminal');
  assert.deepEqual(f.errors.map(error => error.consecutiveFailures), [1, 2, 1, 2]);
});

test('execution failure or timeout is not retried and stops the driver', async () => {
  for (const code of ['timeout', 'transport_error']) {
    let calls = 0;
    const f = fixture({ execute: async () => { calls++; throw Object.assign(new Error(SECRET), { code }); } });
    await assert.rejects(runTextDriver(f.api), error => error.code === 'execution_failed' && !String(error).includes(SECRET));
    assert.equal(calls, 1); assert.equal(f.sleeps.length, 0);
    assert.equal(f.trace[0].skipReason, code === 'timeout' ? 'execution_timeout' : 'execution_failed');
  }
});

test('callback failures cannot impersonate a safe internal error and leak transport data', async () => {
  const f = fixture({ onDecision: () => { throw Object.assign(new Error(SECRET), { code: 'execution_failed' }); } });
  await assert.rejects(runTextDriver(f.api), error => error.code === 'driver_failed' && !String(error).includes(SECRET));
  assert.equal(f.executions.length, 0);
});

test('abort completes promptly during a non-cooperative read, decision, execution or wait', { timeout: 1500 }, async () => {
  for (const stage of ['readState', 'decide', 'execute', 'sleep']) {
    const entered = defer();
    const f = fixture();
    if (stage === 'sleep') f.api.decide = async () => ({ action: 'wait' });
    f.api[stage] = async () => { entered.resolve(); return new Promise(() => {}); };
    const running = runTextDriver(f.api);
    await entered.promise; f.controller.abort(SECRET);
    assert.equal((await running).reason, 'aborted');
    assert.equal(f.trace.filter(trace => !trace.skipReason).length, 0);
  }
});

test('an already aborted driver never reads or calls an API', async () => {
  const f = fixture({ readState: () => assert.fail('no read'), decide: () => assert.fail('no API') });
  f.controller.abort();
  assert.deepEqual(await runTextDriver(f.api), { reason: 'aborted', iterations: 0, executed: 0 });
});

test('terminal state initially or during revalidation ends without a click', async () => {
  for (const terminalRead of [1, 2]) for (const phase of ['finished', 'cancelled']) {
    let reads = 0;
    const f = fixture({ readState: async () => ({ state: state(++reads >= terminalRead ? phase : 'racing'), observedAt: 10000 }) });
    assert.equal((await runTextDriver(f.api)).reason, 'terminal');
    assert.equal(f.executions.length, 0);
  }
});
