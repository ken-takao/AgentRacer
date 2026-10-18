import test from 'node:test';
import assert from 'node:assert/strict';
import { publishInBackground } from './server.mjs';

function fixture() {
  const player = { publications: new Map(), publicationTask: null };
  return { player, run: { players: { red: player }, logs: [], secrets: new Set() } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('an update queued as the previous drain ends is published without another event', async () => {
  const { run, player } = fixture();
  const completed = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  publishInBackground(run, 'red', 'frame', () => barrier);
  await Promise.resolve();
  release();
  // This microtask ran before the old worker's .finally cleanup, leaving an
  // update stranded behind a non-null task marker in the previous version.
  queueMicrotask(() => publishInBackground(run, 'red', 'decision', async () => { completed.push('decision'); }));
  await tick();
  assert.deepEqual(completed, ['decision']);
  assert.equal(player.publications.size, 0);
  assert.equal(player.publicationTask, null);
});

test('coalesces pending updates and awaiting the drain includes the latest values', async () => {
  const { run, player } = fixture();
  const completed = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  publishInBackground(run, 'red', 'frame', async () => { await barrier; completed.push('frame-1'); });
  await Promise.resolve();
  publishInBackground(run, 'red', 'frame', async () => { completed.push('frame-2'); });
  publishInBackground(run, 'red', 'frame', async () => { completed.push('frame-3'); });
  publishInBackground(run, 'red', 'decision', async () => { completed.push('decision'); });
  const drain = player.publicationTask;
  release();
  await drain;
  assert.deepEqual(completed, ['frame-1', 'frame-3', 'decision']);
  assert.equal(player.publications.size, 0);
  assert.equal(player.publicationTask, null);
});

test('a synchronous publisher failure neither races startup assignment nor blocks later updates', async () => {
  const { run, player } = fixture();
  const completed = [];
  publishInBackground(run, 'red', 'frame', () => { throw new Error('fixture failure'); });
  assert.ok(player.publicationTask instanceof Promise);
  await player.publicationTask;
  assert.equal(player.publicationTask, null);
  assert.equal(run.logs.length, 1);
  publishInBackground(run, 'red', 'decision', async () => { completed.push('decision'); });
  await player.publicationTask;
  assert.deepEqual(completed, ['decision']);
  assert.equal(player.publicationTask, null);
});
