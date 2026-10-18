import assert from "node:assert/strict";
import * as THREE from "three";
import { cameraPose, selectAutoShot, smoothCameraHeading, type CameraAnchor, type CameraPose, type CameraShot } from "../lib/race-camera.ts";
const pair: CameraAnchor[] = [{ x: 8, y: 0, z: 17, heading: 0, speed: 2.5 }, { x: -4, y: 0, z: 25, heading: 0.1, speed: 1.8 }];
const times = [0, 8, 15, 22, 30, 37];
const cycle = times.map(t => selectAutoShot('racing', t, pair, [50, 40]));
assert.deepEqual(cycle.map(s => [s.kind, s.focus]), [['chase', 0], ['side', 1], ['duel', undefined], ['chase', 1], ['side', 0], ['overview', undefined]]);
assert.deepEqual(selectAutoShot('racing', 40, pair, [50, 40]), cycle[0]);
assert.equal(Array.from({ length: 400 }, (_, i) => selectAutoShot('racing', i / 10, pair, [50, 40])).filter(s => s.kind === 'overview').length, 30);
assert.equal(selectAutoShot('countdown', 4, pair, [0, 0]).kind, 'grid');
assert.equal(selectAutoShot('lobby', 4, pair, [0, 0]).kind, 'grid');
const distant = [{ x: -45, y: 0, z: 12, heading: 0 }, { x: 45, y: 0, z: -20, heading: Math.PI }];
assert.equal(selectAutoShot('racing', 16, distant, [40, 80]).focus, 1);
assert.equal(selectAutoShot('racing', 16, distant, [80, 40]).focus, 0);
assert.notEqual(selectAutoShot('racing', 16, [{...pair[0], y: 14}, pair[1]], [50, 40]).kind, 'duel', 'grade-separated cars are not a close battle');

function assertFramed(pose: CameraPose, anchor: CameraAnchor, aspect: number) {
  const camera = new THREE.PerspectiveCamera(pose.fov, aspect, 0.15, 1000);
  camera.position.set(...pose.eye); camera.lookAt(new THREE.Vector3(...pose.target)); camera.updateMatrixWorld();
  for (const forward of [-2.6, 2.6]) for (const side of [-1.15, 1.15]) for (const y of [0.1, 2.9]) {
    const slope = anchor.slope ?? 0;
    const horizontal = Math.cos(slope) * forward - Math.sin(slope) * y;
    const vertical = Math.sin(slope) * forward + Math.cos(slope) * y;
    const point = new THREE.Vector3(anchor.x + Math.cos(anchor.heading) * horizontal - Math.sin(anchor.heading) * side, (anchor.y ?? 0) + vertical, anchor.z + Math.sin(anchor.heading) * horizontal + Math.cos(anchor.heading) * side).project(camera);
    assert.ok(Math.abs(point.x) < 1, `vehicle width remains framed: ${point.x}`); assert.ok(Math.abs(point.y) < 1, `vehicle and label remain framed: ${point.y}`); assert.ok(point.z > -1 && point.z < 1);
  }
}
const shots: CameraShot[] = [...cycle, { key: 'grid', label: 'GRID', kind: 'grid' }];
for (const aspect of [0.6, 0.9, 1.64, 2.5]) for (const seconds of [0, 7, 25, 500]) for (const heading of [-Math.PI, -1.5, 0, 1.5, Math.PI]) for (const elevation of [0, 14]) {
  const anchors = pair.map(p => ({ ...p, heading, y: elevation }));
  for (const shot of shots) {
    const pose = cameraPose(shot, anchors, aspect, seconds, true);
    assert.ok([...pose.eye, ...pose.target, pose.fov].every(Number.isFinite));
    assert.ok(pose.eye[1] > elevation + 3.3, 'camera stays above the car roof and follows bridge elevation');
    for (const p of shot.focus === undefined ? anchors : [anchors[shot.focus]]) assertFramed(pose, p, aspect);
  }
}
for (const aspect of [0.6, 1.64]) distant.forEach(p => assertFramed(cameraPose(cycle[2], distant, aspect, 7, true), p, aspect));
for (const phase of ['finished', 'cancelled']) {
  const shot = selectAutoShot(phase, 3, pair, [200, 180]); assert.equal(shot.kind, 'overview');
  assert.deepEqual(cameraPose(shot, pair, 1.64, 0, false), cameraPose(shot, pair, 1.64, 500, false));
}
for (const aspect of [0, NaN, Infinity]) assert.ok(Object.values(cameraPose(cycle[0], [], aspect, NaN, true)).flat().every(Number.isFinite));
const chase = cameraPose(cycle[0], pair, 1.64, 0, true), side = cameraPose(cycle[1], pair, 1.64, 0, true);
assert.ok(chase.eye[1] < 4); assert.ok(side.eye[1] < 4); assert.ok(chase.fov >= 60);
console.log('Close perspective camera framing, elevation and 37/40-second action coverage tests passed');

// Camera yaw follows the shortest turn and is independent of the drawing frequency.
const wrapped = smoothCameraHeading(Math.PI - 0.02, -Math.PI + 0.02, 1 / 40);
assert.ok(wrapped > Math.PI - 0.02 && wrapped < Math.PI + 0.02);
const follow = (fps: number) => { let heading = 0; for (let i = 0; i < fps; i++) heading = smoothCameraHeading(heading, 1.4, 1 / fps); return heading; };
assert.ok(Math.abs(follow(20) - follow(60)) < 1e-10);
// Even a sharp curve cannot shrink the eye's orbit or move its target off the tracked car.
for (const actualHeading of [0, 1.2, Math.PI, -2]) for (const cameraHeading of [-2.5, 0, 2.5]) {
  const realCar = { ...pair[0], x: 80, z: -35, heading: actualHeading };
  const anchors = [{ ...realCar, heading: cameraHeading }, pair[1]];
  for (const kind of ['chase', 'side'] as const) {
    const pose = cameraPose({ key: kind, label: kind, kind, focus: 0 }, anchors, 1.64, 8, true);
    assertFramed(pose, realCar, 1.64);
    const vehicleRadius = Math.hypot(2.6, 1.15);
    assert.ok(Math.hypot(pose.eye[0] - realCar.x, pose.eye[2] - realCar.z) - vehicleRadius > 7,
      'even a hairpin keeps the camera at least seven metres outside the vehicle bounds');
  }
}

// The closest camera must frame pitched cars on bridge approaches, including
// when a collision stops them and the speed-dependent lens widening disappears.
// The current courses reach 0.334 radians; cover both directions with margin.
for (const aspect of [0.6, 0.9, 1.64, 2.5]) for (const slope of [-0.35, 0, 0.35]) for (const speed of [0, 1, 1.8, 2.5, 5]) {
  for (const kind of ['chase', 'side'] as const) {
    const car = { ...pair[0], y: 14, slope, speed };
    const shot: CameraShot = { key: kind, label: kind, kind, focus: 0 };
    const moving = cameraPose(shot, [car, pair[1]], aspect, 7, true);
    assertFramed(moving, car, aspect);
    const stopped = cameraPose(shot, [{ ...car, speed: 0 }, pair[1]], aspect, 7, true);
    const inactive = cameraPose(shot, [car, pair[1]], aspect, 7, false);
    assert.equal(stopped.fov, inactive.fov, 'stationary cars do not retain the speed effect');
    assert.ok(moving.fov >= stopped.fov && moving.fov <= stopped.fov + 9, 'lens change remains bounded');
    assert.deepEqual(moving.eye, stopped.eye, 'speed never changes the camera tracking position');
    assert.deepEqual(moving.target, stopped.target, 'speed never projects the car ahead');
  }
}
