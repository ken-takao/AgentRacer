import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { advance, applyInput, createRace, type RaceState } from '../lib/race-engine.ts';

// Execute the real Worker route against a D1 compare-and-swap test double.
// Parallel requests initially read the same version, as they do on separate Workers.
const routeFile = new URL('../app/api/races/[[...path]]/route.ts', import.meta.url);
const source = (await readFile(routeFile, 'utf8'))
  .replace("import { env } from 'cloudflare:workers';", 'const env = globalThis.__raceTestEnv;')
  .replace(/from '(\.\.[^']+)'/g, (_, path) => `from '${new URL(path + '.ts', routeFile).href}'`);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const id = 'race_' + 'a'.repeat(32);
const now = 1_800_000_000_000;
const digest = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

async function harness(initial?: RaceState, simultaneousWrites = 0) {
  let state = initial ?? createRace('mutations', now - 5000);
  if (!initial) {
    for (const player of ['red', 'blue'] as const) {
      state = applyInput(state, player, { type: 'join' }, now - 5000);
      state = applyInput(state, player, { type: 'ready' }, now - 5000);
    }
    state = advance(state, now);
  }
  const stored = { id, version: 0, state: JSON.stringify(state), expires_at: now + 100000, red_hash: await digest('red-player'), blue_hash: await digest('blue-player') };
  let conflicts = 0;
  let waitingWrites = 0;
  let releaseWrites!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrites = resolve; });
  const env = { RACE_ADMIN_KEY: 'test-admin-only', DB: {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { assert.match(sql, /SELECT \* FROM races/); return { ...stored }; },
        async all() { return { results: [] }; },
        async run() {
          assert.match(sql, /UPDATE races SET state/);
          if (simultaneousWrites && ++waitingWrites <= simultaneousWrites) {
            if (waitingWrites === simultaneousWrites) releaseWrites();
            await writeGate;
          }
          if (values[2] !== stored.version) { conflicts++; return { meta: { changes: 0 } }; }
          stored.state = values[0] as string; stored.version++;
          return { meta: { changes: 1 } };
        },
      };
    },
  }};
  (globalThis as any).__raceTestEnv = env;
  const route = await import('data:text/javascript;base64,' + Buffer.from(compiled + '\n//' + crypto.randomUUID()).toString('base64'));
  delete (globalThis as any).__raceTestEnv;
  const post = (action: string, payload: unknown, token = 'test-admin-only') => route.POST(new Request(`https://race.test/api/races/${id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload),
  }), { params: Promise.resolve({ path: [id, action] }) }) as Promise<Response>;
  return { stored, post, state: () => JSON.parse(stored.state) as RaceState, conflicts: () => conflicts };
}
const jump = { player: 'red', input: { type: 'jump' } };
const obstacle = { assetId: 'banana_peel', lane: 0, progress: 16 };

test('a simultaneous jump burst commits once; rejected requests change no state', async context => {
  context.mock.method(Date, 'now', () => now);
  const h = await harness(undefined, 8);
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.post('input', jump, 'red-player')));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 7);
  assert.equal(h.stored.version, 1);
  assert.equal(h.state().history.filter(e => e.type === 'jump_started').length, 1);
  assert.ok(h.conflicts() > 0);
  const previous = { ...h.stored };
  assert.equal((await h.post('input', jump, 'red-player')).status, 409);
  assert.deepEqual(h.stored, previous);
});

test('jump, steering and placement racing the same D1 row all survive CAS retry', async context => {
  context.mock.method(Date, 'now', () => now);
  const h = await harness(undefined, 3);
  const results = await Promise.all([
    h.post('input', jump, 'red-player'),
    h.post('input', { player: 'blue', input: { type: 'lane', lane: 1 } }, 'blue-player'),
    h.post('obstacles', obstacle),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 201]);
  assert.equal(h.state().players.blue.targetLane, 1);
  assert.equal(h.state().history.filter(e => e.type === 'jump_started').length, 1);
  assert.equal(h.state().history.filter(e => e.type === 'obstacle_placed').length, 1);
  assert.ok(h.state().course.obstacles.some(o => o.assetId === 'banana_peel'));
  assert.equal(h.stored.version, 3);
});

test('spectators and both driver capabilities cannot place obstacles', async context => {
  context.mock.method(Date, 'now', () => now);
  const h = await harness(); const previous = { ...h.stored };
  for (const token of ['', 'red-player', 'blue-player']) assert.equal((await h.post('obstacles', obstacle, token)).status, 401);
  assert.equal((await h.post('input', { player: 'red', input: { type: 'obstacles', ...obstacle } }, 'red-player')).status, 409);
  assert.deepEqual(h.stored, previous);
});

test('concurrent placements honor cooldown atomically and invalid placements never commit', async context => {
  context.mock.method(Date, 'now', () => now);
  const h = await harness(undefined, 2);
  const results = await Promise.all([h.post('obstacles', obstacle), h.post('obstacles', { ...obstacle, lane: 2, progress: 20 })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(h.stored.version, 1);
  const previous = { ...h.stored };
  assert.equal((await h.post('obstacles', { ...obstacle, progress: -1 })).status, 409);
  assert.deepEqual(h.stored, previous);
});

test('before start and after finish jumps are rejected without persisting clock advancement', async context => {
  context.mock.method(Date, 'now', () => now);
  for (const phase of ['lobby', 'finished', 'cancelled'] as const) {
    const initial = createRace('phase', now - 1000); initial.phase = phase; initial.players.red.joined = true;
    const h = await harness(initial); const previous = { ...h.stored };
    assert.equal((await h.post('input', jump, 'red-player')).status, 409);
    assert.deepEqual(h.stored, previous);
  }
});

test('sprint jump and placement preserve pace and sixty-unit lead checks through CAS retries', async context => {
  context.mock.method(Date, 'now', () => now);
  let initial = createRace('sprint-mutations', now - 5000, { pace: 'sprint-2x' });
  initial.course.obstacles = []; initial.course.junctions = [];
  for (const player of ['red', 'blue'] as const) {
    initial = applyInput(initial, player, { type: 'join' }, now - 5000);
    initial = applyInput(initial, player, { type: 'ready' }, now - 5000);
  }
  initial = advance(initial, now);
  const h = await harness(initial, 3);
  const results = await Promise.all([
    h.post('input', jump, 'red-player'),
    h.post('input', { player: 'blue', input: { type: 'lane', lane: 1 } }, 'blue-player'),
    h.post('obstacles', { ...obstacle, progress: 60 }),
  ]);
  assert.deepEqual(results.map(response => response.status), [200, 200, 201]);
  assert.equal(h.state().pace, 'sprint-2x');
  assert.equal(h.state().players.red.jumpEndsAt, now + 800);
  assert.equal(h.state().history.filter(event => event.type === 'obstacle_placed').length, 1);
  assert.ok(h.conflicts() > 0);
  const before = { ...h.stored };
  const rejected = await h.post('obstacles', { ...obstacle, lane: 2, progress: 59 });
  assert.equal(rejected.status, 409);
  const rejectedBody = await rejected.json() as { error: string };
  assert.match(rejectedBody.error, /60以上/);
  assert.deepEqual(h.stored, before);
});
