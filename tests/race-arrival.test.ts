import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeRaceArrival, type RaceArrivalState } from '../lib/race-arrival.ts';

const id = 'race_' + 'a'.repeat(32);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('page entry requests once; all preparation polling is read-only until joining the active race', async t => {
  const methods: string[] = [];
  const updates: RaceArrivalState[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    methods.push(init.method || 'GET');
    if (init.method === 'POST') assert.deepEqual(JSON.parse(init.body as string), { previousRaceId: id });
    return Response.json(methods.length === 1 ? { status: 'offline', canRequest: true } : methods.length < 4 ? { status: 'waiting', requestId: 'one' } : { status: 'active', raceId: id });
  });
  let stop = () => {};
  await new Promise<void>(resolve => {
    stop = observeRaceArrival({ previousRaceId: id, onUpdate: s => updates.push(s), onReady: race => { assert.equal(race, id); resolve(); } }, undefined, 1);
    t.after(() => stop());
  });
  await sleep(10);
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'GET']);
  assert.deepEqual(updates.map(s => s.status), ['waiting', 'waiting', 'active']);
});

test('an existing race joins immediately without subsequent requests', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'active', raceId: id }); });
  await new Promise<void>(resolve => {
    const stop = observeRaceArrival({ onUpdate: () => {}, onReady: () => resolve() }, undefined, 1);
    t.after(stop);
  });
  await sleep(10);
  assert.equal(calls, 1);
});

test('failed start is not retried even when the operator becomes available again', async t => {
  const methods: string[] = [];
  const updates: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    methods.push(init.method || 'GET');
    return Response.json({ status: 'failed', canRequest: init.method !== 'POST' });
  });
  const stop = observeRaceArrival({ onUpdate: s => updates.push(s.status), onReady: () => assert.fail('must not navigate') }, undefined, 1);
  t.after(stop);
  await sleep(20);
  stop();
  assert.ok(methods.length > 1);
  assert.equal(methods.filter(m => m === 'POST').length, 1);
  assert.ok(updates.every(s => s === 'failed'));
});

test('an uncertain POST result is recovered using GET, without resubmitting a paid start', async t => {
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    methods.push(init.method || 'GET');
    if (methods.length === 1) return Response.json({ status: 'offline', canRequest: true });
    if (init.method === 'POST') throw new TypeError('network lost after accepting start');
    return Response.json({ status: 'active', raceId: id });
  });
  const updates: string[] = [];
  await new Promise<void>(resolve => {
    const stop = observeRaceArrival({ onUpdate: s => updates.push(s.status), onReady: () => resolve() }, undefined, 1);
    t.after(stop);
  });
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.deepEqual(updates, ['error', 'active']);
});

test('leaving the page aborts in-flight work and cannot navigate or update later', async t => {
  let respond!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Promise<Response>(resolve => { respond = resolve; });
  });
  const stop = observeRaceArrival({ onUpdate: () => assert.fail('late update'), onReady: () => assert.fail('late navigation') }, undefined, 1);
  stop();
  assert.equal(signal?.aborted, true);
  respond(Response.json({ status: 'active', raceId: id }));
  await sleep(10);
});

test('malformed active destinations are never used for navigation', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'active', raceId: '//other.example' }));
  const updates: string[] = [];
  const stop = observeRaceArrival({ onUpdate: s => updates.push(s.status), onReady: () => assert.fail('unsafe destination') }, undefined, 100);
  t.after(stop);
  await sleep(10);
  stop();
  assert.deepEqual(updates, ['error']);
});


test('an offline arrival waits then starts automatically once when the operator connects', async t => {
  const methods: string[] = [];
  const updates: RaceArrivalState[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    methods.push(init.method || 'GET');
    if (methods.length === 1) return Response.json({ status: 'offline', canRequest: false });
    if (methods.length === 2) return Response.json({ status: 'offline', canRequest: true });
    return Response.json({ status: 'active', raceId: id });
  });
  await new Promise<void>(resolve => {
    const stop = observeRaceArrival({ onUpdate: s => updates.push(s), onReady: () => resolve() }, undefined, 1);
    t.after(stop);
  });
  assert.deepEqual(methods, ['GET', 'GET', 'POST']);
  assert.equal(updates[0].awaitingAvailability, true);
});
