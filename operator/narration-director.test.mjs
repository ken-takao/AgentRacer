import test from 'node:test';
import assert from 'node:assert/strict';
import { createNarrationDirector } from './narration-director.mjs';

function state(at, phase = 'racing', extra = {}) {
  return { phase, updatedAt: at, startedAt: 10000, winner: null, course: { length: 200 }, history: [],
    players: { red: { progress: 20, slowedUntil: 0 }, blue: { progress: 15, slowedUntil: 0 } }, ...extra };
}

test('director deduplicates replayed history and distinguishes obstacle slowdown from car contact', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now, minGapMs: 0 });
  director.observe(state(now)); assert.equal(director.next().kind, 'start');
  now += 3000;
  const crash = { at: now, type: 'collision', playerId: 'red', obstacleId: 'gate-1' };
  director.observe(state(now, 'racing', { history: [crash] }));
  const event = director.next();
  assert.equal(event.kind, 'obstacle:red'); assert.match(event.text, /スカーレット.*障害物.*減速/);
  director.observe(state(now, 'racing', { history: [crash] })); assert.equal(director.next(), null);
  now += 3000;
  director.observe(state(now, 'racing', { history: [crash, { at: now, type: 'car_collision' }] }));
  assert.match(director.next().text, /車同士が接触.*両車/);
});

test('finish overrides optional commentary and only uses authoritative result', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now, minGapMs: 0 });
  director.observe(state(now)); director.next(); now += 4000;
  director.observe(state(now, 'racing', { history: [{ at: now, type: 'route_entered', playerId: 'blue', route: 'left' }] }));
  director.observe(state(++now, 'finished', { winner: 'blue', finishReason: 'finish_line' }));
  assert.match(director.next().text, /勝者はコバルト/);
  assert.equal(director.next(), null);
  director.observe(state(now - 1)); assert.equal(director.next(), null);
});

test('old facts expire while waiting for the connection; cancelled race has no winner', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now });
  director.observe(state(now)); now += 7000; assert.equal(director.next(), null);
  director.observe(state(now, 'cancelled', { winner: 'red' }));
  assert.match(director.next().text, /勝者の発表はない/);
});

test('lead changes require a stable margin and crossing into the lead, not parallel jitter', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now, minGapMs: 0, cheerGapMs: 60000 });
  const positions = (r, b) => ({ red: { progress: r }, blue: { progress: b } });
  director.observe(state(now)); director.next();
  now += 1500; director.observe(state(now)); assert.equal(director.next(), null);
  now += 1500; director.observe(state(now, 'racing', { players: positions(20, 21) })); assert.equal(director.next(), null);
  now += 1500; director.observe(state(now, 'racing', { players: positions(20, 23) })); assert.equal(director.next(), null);
  now += 1500; director.observe(state(now, 'racing', { players: positions(22, 25) })); assert.equal(director.next().kind, 'lead');
});

test('event age consumes queue TTL instead of starting a second freshness window', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now, minGapMs: 0 });
  director.observe(state(now)); director.next();
  now = 14000;
  director.observe(state(now, 'racing', { history: [{ at: 10500, type: 'collision', playerId: 'red', obstacleId: 'gate-old' }] }));
  now += 501;
  assert.equal(director.next(), null);
  director.observe(state(now, 'racing', { history: [{ at: 10000, type: 'car_collision' }] }));
  assert.equal(director.next(), null);
});

test('small progress gap does not claim physical proximity on different branches', () => {
  let now = 10000;
  const director = createNarrationDirector({ now: () => now, minGapMs: 0 });
  const snapshot = at => state(at, 'racing', { players: { red: { progress: 80, routeChoices: { fork: 'left' } }, blue: { progress: 79, routeChoices: { fork: 'right' } } } });
  director.observe(snapshot(now)); director.next(); now += 11000; director.observe(snapshot(now));
  assert.match(director.next().text, /進行差はわずか/);
});
