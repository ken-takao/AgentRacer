import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createDriveObservation, sanitizeDriveObservation, driveActionStatus, expectedInputForAction } from './drive-observation.mjs';

const source = await readFile(new URL('../lib/race-course.ts', import.meta.url), 'utf8');
const courseCode = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { createCourseFeatures, roadKey } = await import(`data:text/javascript;base64,${Buffer.from(courseCode).toString('base64')}`);
const driver = overrides => ({ joined: true, ready: true, progress: 20, lane: 1, targetLane: 1, speedMode: 'normal', speed: 1.8,
  jumpAvailable: true, upcomingObstacles: [], routeChoices: {}, ...overrides });
const state = overrides => ({ version: 2, phase: 'racing', updatedAt: 10000, course: { length: 200, ...createCourseFeatures('example', 200), obstacles: [] },
  players: { red: driver(), blue: driver({ progress: 25, lane: 2, targetLane: 2 }) }, ...overrides });
const observe = s => createDriveObservation({ state: s, color: 'red', observedAt: 9900 });

test('interaction rules come from saved state; missing or legacy modes keep solid decisions', () => {
  assert.equal(observe(state()).carInteraction, 'solid');
  assert.equal(observe(state({ carInteraction: 'ghost' })).carInteraction, 'ghost');
  assert.equal(observe(state({ version: 1, carInteraction: 'ghost' })).carInteraction, 'solid');
  const invalid = { ...observe(state()), carInteraction: 'unknown' };
  assert.throws(() => sanitizeDriveObservation(invalid), error => error.code === 'invalid_observation');
});

test('only driver-visible obstacles and fixed allowlisted fields reach the observation', () => {
  const s = state(); const j = s.course.junctions[0];
  s.players.red.routeChoices[j.id] = 'left';
  s.players.red.upcomingObstacles = [
    { progress: 19, blockedLane: 0 }, { progress: 20, blockedLane: 0 },
    { progress: 80, blockedLane: 2, assetId: 'banana_peel', token: 'private-secret' },
    { progress: 80.1, blockedLane: 1 },
    { progress: 60, blockedLane: 1, junctionId: j.id, route: 'right' },
    { progress: 50, blockedLane: 0, junctionId: j.id, route: 'left', assetId: 'traffic_cone' },
  ];
  s.course.obstacles = [{ progress: 40, blockedLane: 1, token: 'private-secret' }];
  s.seed = 'private-secret'; s.history = [{ token: 'private-secret' }]; s.token = 'private-secret';
  s.players.red.sessionId = 'private-secret'; s.players.blue.routeChoices = { secret: 'private-secret' };
  s.course.junctions[0].name = 'private-secret';
  s.course.junctions[0].routes.left.description = 'private-secret';
  const o = observe(s);
  assert.deepEqual(o.obstacles, [{ distance: 30, lane: 0, kind: 'obstacle', asset: 'traffic_cone' }, { distance: 60, lane: 2, kind: 'banana', asset: 'banana_peel' }]);
  assert.equal(o.observedAt, 9900);
  assert.equal(o.stateAt, 10000);
  assert.equal(o.route.distanceToExit, null);
  assert.ok(!JSON.stringify(o).includes('private-secret'));
  assert.ok(!('speed' in o.rival));
  assert.ok(!('blockedLanes' in o.route.routes.left));
  assert.equal(o.route.routes.left.obstacleCount, j.routes.left.blockedLanes.length);
  const dirty = structuredClone(o); dirty.secret = 'private-secret'; dirty.driver.token = 'private-secret'; dirty.obstacles[0].token = 'private-secret';
  assert.deepEqual(sanitizeDriveObservation(dirty), o);
});

test('current road and collision visibility match course helpers on every layout, fork, side and boundary', () => {
  const layouts = new Map();
  for (let i = 0; layouts.size < 3 && i < 100; i++) { const course = createCourseFeatures(`case-${i}`, 200); layouts.set(course.layout, course); }
  assert.equal(layouts.size, 3);
  for (const course of layouts.values()) for (const j of course.junctions) for (const route of ['left', 'right']) {
    for (const progress of [j.start - .001, j.start - .00000005, j.start, (j.start + j.end) / 2, j.end - .001, j.end]) {
      const s = state({ course: { length: 200, ...course } });
      s.players.red = driver({ progress, routeChoices: { [j.id]: route } });
      s.players.blue = driver({ progress, routeChoices: { [j.id]: route === 'left' ? 'right' : 'left' } });
      const o = observe(s);
      assert.equal(o.rival.sameRoad, roadKey(course, s.players.red) === roadKey(course, s.players.blue));
      const active = progress >= j.start && progress < j.end;
      assert.equal(o.road.kind, active ? 'branch' : 'main');
      if (o.route?.junctionId === j.id) assert.equal(o.route.locked, progress >= j.start - 1e-7);
      if (active) { assert.equal(o.road.route, route); assert.equal(o.route.distanceToExit, j.end - progress); }
    }
  }
});

test('rival radar remains available outside front view without leaking its unseen controls', () => {
  for (const [gap, visible] of [[-4, true], [-4.1, false], [60, true], [60.1, false]]) {
    const s = state(); s.course.junctions = []; s.players.red.progress = 0; s.players.blue.progress = gap;
    const o = observe(s); assert.equal(o.rival.frontViewVisible, visible); assert.equal(o.rival.distance, gap);
  }
});

test('sprint observations follow the saved 120-unit horizon while classic and v1 stay at 60', () => {
  for (const [version, pace, distance] of [[2, 'sprint-2x', 120], [2, undefined, 60], [1, 'sprint-2x', 60]]) {
    const s = state({ version, pace, paceRules: { visibleDistance: distance } }); s.course.junctions = [];
    s.players.red.upcomingObstacles = [{ progress: 110, blockedLane: 1 }, { progress: 141, blockedLane: 0 }];
    s.players.blue.progress = 110;
    const o = observe(s);
    assert.equal(o.course.visibleDistance, distance);
    assert.equal(o.obstacles.length, distance === 120 ? 1 : 0);
    assert.equal(o.rival.frontViewVisible, distance === 120);
  }
});

test('preparation controls are allowed but same settings, locked routes and unavailable jumps are rejected', () => {
  for (const phase of ['lobby', 'countdown', 'racing']) {
    const o = observe(state({ phase }));
    assert.equal(driveActionStatus('lane_left', o).valid, true);
    assert.equal(driveActionStatus('lane_center', o).reason, 'same_setting');
    assert.equal(driveActionStatus('speed_turbo', o).valid, true);
    assert.equal(driveActionStatus('speed_normal', o).reason, 'same_setting');
    assert.equal(driveActionStatus(`route_${o.route.selected}`, o).reason, 'same_setting');
    assert.equal(driveActionStatus(`route_${o.route.selected === 'left' ? 'right' : 'left'}`, o).valid, true);
    assert.equal(driveActionStatus('jump', o).valid, phase === 'racing');
    assert.deepEqual(driveActionStatus('wait', o), { valid: true, reason: 'wait', input: null });
  }
  const s = state(); s.players.red.progress = s.course.junctions[0].start;
  assert.equal(driveActionStatus('route_left', observe(s)).reason, 'route_locked');
  for (const phase of ['finished', 'cancelled']) assert.equal(driveActionStatus('lane_left', observe(state({ phase }))).reason, 'race_finished');
  for (const effect of [{ jumpAvailable: false }, { jumpEndsAt: 10100 }, { jumpReadyAt: 10100 }, { spinEndsAt: 10100 }]) {
    const s = state(); Object.assign(s.players.red, effect); assert.equal(driveActionStatus('jump', observe(s)).reason, 'jump_unavailable');
  }
  const unjoined = state(); unjoined.players.red.joined = false;
  assert.equal(driveActionStatus('lane_left', observe(unjoined)).reason, 'not_joined');
});

test('actions map to server inputs without route/lane ambiguity or invented control', () => {
  const o = observe(state());
  assert.deepEqual(expectedInputForAction('lane_right', o), { type: 'lane', lane: 2 });
  assert.deepEqual(expectedInputForAction('route_right', o), { type: 'route', junctionId: o.route.junctionId, route: 'right' });
  assert.deepEqual(expectedInputForAction('speed_slow', o), { type: 'speed', speed: 'slow' });
  assert.deepEqual(expectedInputForAction('jump', o), { type: 'jump' });
  assert.equal(driveActionStatus('__proto__', o).reason, 'invalid_action');
  const done = state(); done.players.red.progress = 190;
  assert.equal(driveActionStatus('route_right', observe(done)).reason, 'no_route');
});

test('invalid values and missing per-player observations fail closed without echoing source text', () => {
  const s = state(); s.players.red.upcomingObstacles = undefined;
  assert.throws(() => observe(s), { code: 'invalid_observation' });
  const dirty = observe(state()); dirty.driver.speed = NaN;
  assert.throws(() => sanitizeDriveObservation(dirty), { code: 'invalid_observation' });
  assert.throws(() => createDriveObservation({ state: { secret: 'do-not-print' }, color: 'red', observedAt: 10000 }), error => error.code === 'invalid_observation' && !error.message.includes('do-not-print'));
});
