import assert from 'node:assert/strict';
import { circuitPosition, circuitAtDistance, circuitBodyOffsets, CIRCUIT_3D, CIRCUIT_LAP_DISTANCE } from '../lib/circuit-geometry.ts';
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
for (const lane of [0, 1, 2]) {
  const start = circuitPosition(0, lane, 200);
  const finish = circuitPosition(200, lane, 200);
  near(start.x, 0); near(start.z, CIRCUIT_3D.radius + (lane - 1) * CIRCUIT_3D.laneWidth);
  near(start.x, finish.x); near(start.z, finish.z); near(start.heading, finish.heading);
  const clamped = circuitPosition(220, lane, 200); near(finish.x, clamped.x); near(finish.z, clamped.z);
}
// Position and forward tangent remain continuous at each straight/curve boundary.
for (const boundary of [0, CIRCUIT_3D.straight, CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, 2 * CIRCUIT_3D.straight + Math.PI * CIRCUIT_3D.radius, CIRCUIT_LAP_DISTANCE]) {
  const before = circuitAtDistance(boundary - 1e-6);
  const after = circuitAtDistance(boundary + 1e-6);
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 3e-6);
  assert.ok(Math.abs(Math.sin(after.heading - before.heading)) < 1e-6);
}
// Fractional lane changes stay on the same course cross-section even on the bends.
for (const progress of [25, 50, 75, 100, 125, 150, 175]) {
  const inner = circuitPosition(progress, 0, 200), outer = circuitPosition(progress, 2, 200);
  near(Math.hypot(outer.x - inner.x, outer.z - inner.z), 2 * CIRCUIT_3D.laneWidth);
  const middle = circuitPosition(progress, 1, 200); near(middle.x, (inner.x + outer.x) / 2); near(middle.z, (inner.z + outer.z) / 2);
}
// Display-only separation always moves nearby cars apart, regardless of lane order.
for (const progress of [0, 40, 50, 140, 150]) for (const lanes of [[1.7, 1], [1, 1.7], [1, 1]]) {
  const red = circuitPosition(progress, lanes[0], 200), blue = circuitPosition(progress, lanes[1], 200);
  const [redOffset, blueOffset] = circuitBodyOffsets(red, blue);
  const displayedRed = { x: red.x - Math.sin(red.heading) * redOffset, z: red.z + Math.cos(red.heading) * redOffset };
  const displayedBlue = { x: blue.x - Math.sin(blue.heading) * blueOffset, z: blue.z + Math.cos(blue.heading) * blueOffset };
  const before = Math.hypot(red.x - blue.x, red.z - blue.z);
  const after = Math.hypot(displayedRed.x - displayedBlue.x, displayedRed.z - displayedBlue.z);
  assert.ok(after >= before + 2.8, `display separation must increase for lanes ${lanes}`);
  near(redOffset + blueOffset, 0);
}
assert.deepEqual(circuitBodyOffsets(circuitPosition(0, 0, 200), circuitPosition(0, 2, 200)), [0, 0]);
console.log('3D circuit coordinate tests passed');
