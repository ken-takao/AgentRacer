import assert from "node:assert/strict";
import { cameraPose, selectAutoShot, type CameraAnchor, type CameraPose, type CameraShot } from "../lib/race-camera.ts";

const pair: CameraAnchor[] = [{ x: 8, z: 17, heading: 0 }, { x: -4, z: 25, heading: 0.1 }];
const cycle = Array.from({ length: 6 }, (_, slot) => selectAutoShot("racing", slot, pair, [50, 40]));
assert.deepEqual(cycle.map(s => [s.kind, s.focus]), [["overview", undefined], ["chase", 0], ["side", 1], ["duel", undefined], ["chase", 1], ["side", 0]]);
assert.deepEqual(selectAutoShot("racing", 6, pair, [50, 40]), cycle[0]);
assert.equal(selectAutoShot("countdown", 4, pair, [0, 0]).kind, "grid");
assert.equal(selectAutoShot("lobby", 4, pair, [0, 0]).kind, "overview");
const distant: CameraAnchor[] = [{ x: -45, z: 12, heading: 0 }, { x: 45, z: -20, heading: Math.PI }];
assert.deepEqual(selectAutoShot("racing", 3, distant, [40, 80]).focus, 1);
assert.deepEqual(selectAutoShot("racing", 3, distant, [80, 40]).focus, 0);

// Verify the actual orthographic projection rather than only the frustum formula.
function assertFramed(pose: CameraPose, anchor: CameraAnchor, aspect: number) {
  const [ex, ey, ez] = pose.eye, [tx, ty, tz] = pose.target;
  const distance = Math.hypot(tx - ex, ty - ey, tz - ez);
  const forward = [(tx - ex) / distance, (ty - ey) / distance, (tz - ez) / distance];
  const flat = Math.hypot(forward[0], forward[2]);
  const right = [-forward[2] / flat, 0, forward[0] / flat];
  const up = [-right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1]];
  // Include the body footprint and a label above the car.
  for (const ox of [-3, 3]) for (const oz of [-3, 3]) for (const y of [0, 5]) {
    const p = [anchor.x + ox - tx, y - ty, anchor.z + oz - tz];
    const x = p.reduce((sum, value, i) => sum + value * right[i], 0);
    const screenY = p.reduce((sum, value, i) => sum + value * up[i], 0);
    assert.ok(Math.abs(x) < pose.height * aspect / 2, "car must remain within horizontal view");
    assert.ok(Math.abs(screenY) < pose.height / 2, "car and label must remain within vertical view");
  }
}
const allShots: CameraShot[] = [...cycle, { key: "grid", label: "GRID", kind: "grid" }];
for (const aspect of [0.6, 0.9, 1.64, 2.5]) for (const seconds of [0, 7, 25, 500]) for (const heading of [-Math.PI, -1.5, 0, 1.5, Math.PI]) {
  const anchors = pair.map(p => ({ ...p, heading }));
  for (const shot of allShots) {
    const pose = cameraPose(shot, anchors, aspect, seconds, true);
    assert.ok([...pose.eye, ...pose.target, pose.height].every(Number.isFinite));
    assert.ok(pose.eye[1] >= 20, "camera clears track furniture");
    for (const p of shot.focus === undefined ? anchors : [anchors[shot.focus]]) assertFramed(pose, p, aspect);
  }
}
// Wide duel shots remain useful even if the drivers separate during a shot's dwell.
for (const aspect of [0.6, 1.64]) {
  const pose = cameraPose(cycle[3], distant, aspect, 7, true);
  distant.forEach(p => assertFramed(pose, p, aspect));
}
for (const phase of ["finished", "cancelled"]) {
  const shot = selectAutoShot(phase, 3, pair, [200, 180]);
  assert.equal(shot.kind, "overview");
  assert.deepEqual(cameraPose(shot, pair, 1.64, 0, false), cameraPose(shot, pair, 1.64, 500, false));
}
for (const aspect of [0, NaN, Infinity]) {
  const pose = cameraPose(cycle[1], [], aspect, NaN, true);
  assert.ok([...pose.eye, ...pose.target, pose.height].every(Number.isFinite));
}
console.log("Automatic camera scheduling and framing tests passed");
