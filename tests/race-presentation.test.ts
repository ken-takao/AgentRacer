import assert from "node:assert/strict";
import { interpolateRace } from "../lib/race-presentation.ts";
const before = { phase: "racing", createdAt: 100, updatedAt: 1000, players: { red: { progress: 10, lane: 0 }, blue: { progress: 12.4, lane: 0 } } };
const after = { ...before, updatedAt: 1500, players: { red: { progress: 11, lane: 0.7 }, blue: { progress: 13.4, lane: 0 } } };
for (const elapsed of [0, 125, 250, 375, 500, 1000, 99999]) {
  const frame = interpolateRace(before, after, elapsed);
  assert.ok(frame.players.red.progress >= 10 && frame.players.red.progress <= 11);
  assert.ok(Math.abs(frame.players.blue.progress - frame.players.red.progress - 2.4) < 1e-9);
}
assert.equal(interpolateRace(before, after, 250).players.red.progress, 10.5);
assert.equal(interpolateRace(before, after, 250).players.red.lane, 0.35);
assert.deepEqual(interpolateRace(before, after, 99999).players, after.players);
assert.equal(interpolateRace(undefined, after, 0), after);
const finished = { ...after, phase: "finished" };
assert.equal(interpolateRace(before, finished, 0), finished);
const anotherRace = { ...after, createdAt: 200 };
assert.equal(interpolateRace(before, anotherRace, 0), anotherRace);
const passingStart = { ...before, version: 2, course: {}, players: { red: { progress: 10, lane: 0 }, blue: { progress: 12.7, lane: 0.4 } } };
const passingEnd = { ...passingStart, updatedAt: 1500, players: { red: { progress: 11.25, lane: 0 }, blue: { progress: 13.2, lane: 1 } } };
for (const elapsed of [0, 100, 225, 400, 500]) {
  assert.equal(interpolateRace(passingStart, passingEnd, elapsed), passingEnd, "skip the entire crossing interval without forward/backward jumps");
}
console.log("Race presentation: shared snapshot interpolation, contact spacing, stalled network and phase changes passed");
