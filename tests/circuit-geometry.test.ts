import assert from 'node:assert/strict';
import { circuitPosition, circuitAtDistance, circuitAtProgress, CIRCUIT_3D, CIRCUIT_LAP_DISTANCE } from '../lib/circuit-geometry.ts';
import { createCourseFeatures, type CourseLayout } from '../lib/race-course.ts';
const near = (a: number, b: number, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
for (const lane of [0, 1, 2]) {
  const start = circuitPosition(0, lane, 200), finish = circuitPosition(200, lane, 200);
  near(start.x, 0); near(start.z, CIRCUIT_3D.radius + (lane - 1) * CIRCUIT_3D.laneWidth);
  near(start.x, finish.x); near(start.z, finish.z); near(start.heading, finish.heading);
  const clamped = circuitPosition(220, lane, 200); near(finish.x, clamped.x); near(finish.z, clamped.z);
}
for (const boundary of [0, CIRCUIT_3D.straight, CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, 2 * CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, CIRCUIT_LAP_DISTANCE]) {
  const before = circuitAtDistance(boundary - 1e-6), after = circuitAtDistance(boundary + 1e-6);
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 3e-6);
  assert.ok(Math.abs(Math.sin(after.heading - before.heading)) < 1e-6);
}
for (const progress of [25, 50, 75, 100, 125, 150, 175]) {
  const inner = circuitPosition(progress, 0, 200), outer = circuitPosition(progress, 2, 200), middle = circuitPosition(progress, 1, 200);
  near(Math.hypot(outer.x - inner.x, outer.z - inner.z), 2 * CIRCUIT_3D.laneWidth); near(middle.x, (inner.x + outer.x) / 2); near(middle.z, (inner.z + outer.z) / 2);
}
const signatures: string[] = [];
for (const layout of ['harbor', 'alpine', 'metro'] as CourseLayout[]) {
  const course = { ...createCourseFeatures('geometry-regression', 200), layout };
  signatures.push(JSON.stringify(circuitPosition(41, 1, 200, course)));
  for (const choice of ['left', 'right'] as const) {
    const routes = Object.fromEntries(course.junctions.map(j => [j.id, choice]));
    let previous = circuitPosition(0, 1, 200, course, routes);
    for (let i = 1; i <= 2000; i++) {
      const p = circuitPosition(i / 10, 1, 200, course, routes);
      assert.ok(Object.values(p).every(Number.isFinite));
      assert.ok(Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) < 1, 'each route must have continuous position');
      assert.ok(Math.abs(Math.sin(p.heading - previous.heading)) < 0.35, 'forks must not make cars spin at joins');
      previous = p;
    }
    const start = circuitPosition(0, 1, 200, course, routes), finish = circuitPosition(200, 1, 200, course, routes);
    near(start.x, finish.x); near(start.z, finish.z); near(start.y, finish.y);
    for (const j of course.junctions) for (const boundary of [j.start, j.end]) {
      const before = circuitPosition(boundary - 1e-5, 1, 200, course, routes), after = circuitPosition(boundary + 1e-5, 1, 200, course, routes);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) < 0.001);
      assert.ok(Math.abs(Math.sin(after.heading - before.heading)) < 0.01);
    }
    // Cars and road ribbons use the identical route/lane coordinates, including bridge elevation.
    for (const progress of [0, 32, 68, 145, 180]) for (const lane of [0, 0.4, 1, 2]) {
      assert.deepEqual(circuitPosition(progress, lane, 200, course, routes), circuitAtProgress(progress, (lane - 1) * CIRCUIT_3D.laneWidth, 200, course, routes));
    }
  }
  for (const j of course.junctions) {
    const progress = (j.start + j.end) / 2;
    const left = circuitPosition(progress, 1, 200, course, { [j.id]: 'left' }), right = circuitPosition(progress, 1, 200, course, { [j.id]: 'right' });
    assert.ok(Math.hypot(left.x - right.x, left.z - right.z) > 25, 'opposite branch roads must be visibly separate');
    assert.ok(left.y - right.y > 1.5, 'fork elevation is represented in car placement');
    assert.deepEqual(circuitPosition(progress, 1, 200, course), circuitPosition(progress, 1, 200, course, { [j.id]: j.defaultRoute }));
  }
  // The central self-crossing has enough vertical clearance for both cars.
  const unsplit = { ...course, junctions: [] };
  const central = Array.from({ length: 2000 }, (_, i) => circuitPosition(i / 10, 1, 200, unsplit)).filter(p => Math.hypot(p.x, p.z) < 1);
  assert.ok(central.some(p => p.y > 12)); assert.ok(central.some(p => p.y < 0.1));
}
assert.equal(new Set(signatures).size, 3, 'seeded layouts must be genuinely different geometry');
for (const bad of [NaN, Infinity, -Infinity]) assert.ok(Object.values(circuitPosition(bad, bad, bad)).every(Number.isFinite));
console.log('Legacy, fork-route, bridge-clearance and circuit continuity tests passed');
