import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createRace, type RaceState } from '../lib/race-engine.ts';
import { isStalePreparation, LAUNCH_TIMING, MAX_PREPARATION_MS, type LaunchState } from '../lib/race-launch.ts';

const routeFile = new URL('../app/api/races/[[...path]]/route.ts', import.meta.url);
const source = (await readFile(routeFile, 'utf8'))
  .replace("import { env } from 'cloudflare:workers';", 'const env = globalThis.__launchTestEnv;')
  .replace(/from '(\.\.[^']+)'/g, (_, path) => `from '${new URL(path + '.ts', routeFile).href}'`);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const ownerId = 'operator_owner_00000001';
const otherOwner = 'operator_owner_00000002';
const initialNow = 1_800_000_000_000;
const raceId = 'race_' + 'a'.repeat(32);

async function harness() {
  let stored: { version: number; state: string } | null = null;
  let conflicts = 0;
  const races = new Map<string, { id: string; state: string; expires_at: number; created_at: number }>();
  const env = { RACE_ADMIN_KEY: 'test-admin-only', DB: {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() {
          if (sql.includes('FROM race_launch_coordinator')) return stored && { ...stored };
          assert.match(sql, /SELECT \* FROM races WHERE id/); return races.get(values[0] as string) ?? null;
        },
        async all() {
          assert.match(sql, /FROM races WHERE expires_at > \? ORDER BY created_at DESC LIMIT 20/);
          return { results: [...races.values()].filter(r => r.expires_at > Number(values[0])).sort((a, b) => b.created_at - a.created_at).slice(0, 20) };
        },
        async run() {
          if (sql.startsWith('CREATE TABLE')) return { meta: { changes: 0 } };
          if (sql.startsWith('INSERT OR IGNORE')) { stored ??= { version: 0, state: values[0] as string }; return { meta: { changes: 1 } }; }
          assert.match(sql, /UPDATE race_launch_coordinator SET state/);
          assert.ok(stored);
          if (values[1] !== stored.version) { conflicts++; return { meta: { changes: 0 } }; }
          stored = { version: stored.version + 1, state: values[0] as string }; return { meta: { changes: 1 } };
        },
      };
    },
  } };
  (globalThis as any).__launchTestEnv = env;
  const route = await import('data:text/javascript;base64,' + Buffer.from(compiled + '\n//' + crypto.randomUUID()).toString('base64'));
  delete (globalThis as any).__launchTestEnv;
  const call = async (path: string[], method = 'GET', payload?: unknown, token?: string, origin: string | null = 'https://race.test') => {
    const response = await route[method](new Request(`https://race.test/api/races/${path.join('/')}`, {
      method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method !== 'GET' ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
    }), { params: Promise.resolve({ path }) }) as Response;
    return { code: response.status, data: await response.json() as any };
  };
  return {
    call, state: () => JSON.parse(stored!.state) as LaunchState, snapshot: () => JSON.stringify(stored), conflicts: () => conflicts,
    request: () => call(['launch'], 'POST', {}), get: () => call(['launch']),
    operator: (action: string, extra: Record<string, unknown> = {}) => call(['launch', 'operator'], 'POST', { ownerId, action, ...extra }, 'test-admin-only', null),
    putRace: (id: string, state: RaceState, expiry = initialNow + 100000) => races.set(id, { id, state: JSON.stringify(state), expires_at: expiry, created_at: state.createdAt }),
  };
}

test('offline visits and repeated GET polling never queue a race', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness();
  assert.equal((await h.request()).data.status, 'offline');
  const before = h.snapshot();
  for (let i = 0; i < 10; i++) assert.equal((await h.get()).data.status, 'offline');
  assert.equal(h.snapshot(), before); assert.equal(h.state().requestId, null);
});

test('concurrent public visits coalesce atomically into one launch request', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness(); await h.operator('heartbeat');
  const responses = await Promise.all(Array.from({ length: 16 }, () => h.request()));
  assert.ok(responses.every(r => r.code === 200 && r.data.status === 'waiting'));
  assert.equal(new Set(responses.map(r => r.data.requestId)).size, 1);
  assert.equal(h.state().status, 'pending'); assert.ok(h.conflicts() > 0);
});

test('one authenticated owner claims once and completion reuses the real race', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness(); await h.operator('heartbeat');
  const requestId = (await h.request()).data.requestId;
  assert.equal((await h.operator('claim', { ownerId: otherOwner })).code, 409);
  const claims = await Promise.all(Array.from({ length: 6 }, () => h.operator('claim')));
  assert.equal(claims.filter(r => r.data.claimedRequestId === requestId).length, 1);
  assert.equal((await h.operator('complete', { requestId, raceId })).code, 404);
  h.putRace(raceId, createRace('launch', initialNow));
  assert.equal((await h.operator('complete', { requestId, raceId, accepting: false })).data.raceId, raceId);
  assert.deepEqual((await h.request()).data, { status: 'active', raceId, canRequest: false });
  assert.equal((await h.operator('complete', { requestId, raceId })).code, 200);
});

test('polling after finish does not restart; only a new visit can enqueue', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness(); await h.operator('heartbeat');
  const requestId = (await h.request()).data.requestId;
  await h.operator('claim'); h.putRace(raceId, createRace('launch', now));
  await h.operator('complete', { requestId, raceId });
  const finished = createRace('launch', now); finished.phase = 'finished'; h.putRace(raceId, finished);
  now += LAUNCH_TIMING.cooldownMs + 1; await h.operator('heartbeat');
  const before = h.snapshot();
  for (let i = 0; i < 10; i++) { await h.get(); assert.equal((await h.operator('claim')).data.claimedRequestId, null); }
  assert.equal(h.snapshot(), before);
  const next = await h.request(); assert.equal(next.data.status, 'waiting'); assert.notEqual(next.data.requestId, requestId);
});

test('failed attempts are rate limited and expired leases are never reclaimed', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness(); await h.operator('heartbeat');
  const requestId = (await h.request()).data.requestId;
  await h.operator('claim'); await h.operator('fail', { requestId });
  assert.equal((await h.request()).data.requestId, requestId); assert.equal(h.state().status, 'failed');
  now += LAUNCH_TIMING.cooldownMs + 1; await h.operator('heartbeat');
  const request2 = (await h.request()).data.requestId; assert.notEqual(request2, requestId); await h.operator('claim');
  now += LAUNCH_TIMING.leaseMs + 1;
  assert.equal((await h.get()).data.status, 'failed');
  assert.equal((await h.operator('claim', { ownerId: otherOwner })).data.claimedRequestId, null);
  assert.equal((await h.operator('complete', { requestId: request2, raceId })).code, 404);
});

test('heartbeats keep slow launches owned; even a stale heartbeat cannot steal an unexpired lease', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness(); await h.operator('heartbeat'); await h.request(); await h.operator('claim');
  now += LAUNCH_TIMING.heartbeatMs + 1;
  assert.equal((await h.operator('claim', { ownerId: otherOwner })).code, 409);
  await h.operator('heartbeat', { accepting: false });
  now += LAUNCH_TIMING.heartbeatMs - 1;
  assert.equal((await h.get()).data.status, 'waiting');
  assert.equal(h.state().status, 'starting');
  assert.ok(h.state().leaseUntil > now);
});

test('old unclaimed demand expires and reconnecting alone does not run it', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness(); await h.operator('heartbeat');
  const oldId = (await h.request()).data.requestId;
  now += LAUNCH_TIMING.pendingMs + 1;
  assert.equal((await h.operator('claim', { ownerId: otherOwner })).data.claimedRequestId, null);
  assert.equal((await h.get()).data.status, 'failed');
  assert.notEqual((await h.request()).data.requestId, oldId);
});

test('stop drops pending demand and resume alone does not launch it', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness(); await h.operator('heartbeat'); await h.request();
  await h.operator('heartbeat', { accepting: false }); assert.equal(h.state().status, 'failed');
  await h.operator('heartbeat', { accepting: true }); assert.equal((await h.operator('claim')).data.claimedRequestId, null);
});

test('manual active races satisfy queued demand without a second claim', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness(); await h.operator('heartbeat'); await h.request();
  h.putRace(raceId, createRace('manual', initialNow));
  const response = await h.operator('claim');
  assert.equal(response.data.claimedRequestId, null); assert.equal(response.data.raceId, raceId); assert.equal(h.state().status, 'active');
});

test('latest excludes cancelled, expired and clock-finished races', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness();
  const old = createRace('active', initialNow - 10000); h.putRace(raceId, old);
  const stopped = createRace('stop', initialNow); stopped.phase = 'cancelled'; h.putRace('race_' + 'b'.repeat(32), stopped);
  const expired = createRace('expired', initialNow); h.putRace('race_' + 'c'.repeat(32), expired, initialNow - 1);
  const clockFinished = createRace('clock', initialNow); clockFinished.phase = 'racing'; clockFinished.startedAt = initialNow - 200000; clockFinished.updatedAt = initialNow - 200000;
  h.putRace('race_' + 'd'.repeat(32), clockFinished);
  assert.deepEqual((await h.call(['latest'])).data, { id: raceId });
  old.phase = 'finished'; h.putRace(raceId, old);
  assert.deepEqual((await h.call(['latest'])).data, { id: null });
});

test('canRequest advertises readiness without queuing, and respects owner, cooldown and pending work', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness();
  assert.equal((await h.get()).data.canRequest, false);
  await h.operator('heartbeat'); assert.equal((await h.get()).data.canRequest, true);
  assert.equal(h.state().requestId, null);
  const requestId = (await h.request()).data.requestId;
  assert.equal((await h.get()).data.canRequest, false);
  await h.operator('claim'); assert.equal((await h.get()).data.canRequest, false);
  await h.operator('fail', { requestId }); assert.equal((await h.get()).data.canRequest, false);
  now += LAUNCH_TIMING.cooldownMs - 1;
  await h.operator('heartbeat'); assert.equal((await h.get()).data.canRequest, false);
  now++; assert.equal((await h.get()).data.canRequest, true);
  await h.operator('heartbeat', { accepting: false }); assert.equal((await h.get()).data.canRequest, false);
  await h.operator('heartbeat', { accepting: true }); assert.equal((await h.get()).data.canRequest, true);
  now += LAUNCH_TIMING.heartbeatMs; assert.equal((await h.get()).data.canRequest, false);
  assert.equal(h.state().requestId, requestId);
});

test('abandoned preparation is excluded after eight minutes, without excluding fresh lobbies', async t => {
  let now = initialNow; t.mock.method(Date, 'now', () => now);
  const h = await harness();
  const lobby = createRace('orphan', now - MAX_PREPARATION_MS + 1);
  h.putRace(raceId, lobby);
  assert.equal(isStalePreparation(lobby, now), false);
  assert.equal((await h.call(['latest'])).data.id, raceId);
  now++;
  assert.equal(isStalePreparation(lobby, now), true);
  assert.equal(isStalePreparation({ ...lobby, phase: 'racing' }, now), false);
  assert.equal((await h.call(['latest'])).data.id, null);
  await h.operator('heartbeat');
  assert.equal((await h.get()).data.canRequest, true);
  assert.equal((await h.request()).data.status, 'waiting');
});

test('public launch validates origin/body and rejects unauthorized coordinator writes', async t => {
  t.mock.method(Date, 'now', () => initialNow);
  const h = await harness(); await h.operator('heartbeat'); const before = h.snapshot();
  assert.equal((await h.call(['launch'], 'POST', {}, undefined, 'https://other.test')).code, 403);
  assert.equal((await h.call(['launch'], 'POST', {}, undefined, null)).code, 403);
  assert.equal((await h.call(['launch'], 'POST', '')).code, 400);
  assert.equal((await h.call(['launch'], 'POST', { previousRaceId: '../../admin' })).code, 400);
  for (const token of [undefined, 'player-token']) assert.equal((await h.call(['launch', 'operator'], 'POST', { ownerId, action: 'heartbeat' }, token)).code, 401);
  assert.equal((await h.operator('heartbeat', { accepting: 'yes' })).code, 400);
  assert.equal((await h.operator('claim', { ownerId: 'invalid' })).code, 400);
  assert.equal(h.snapshot(), before);
});
