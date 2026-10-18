import assert from "node:assert/strict";
import { interpolateRace } from "../lib/race-presentation.ts";
import type { CourseFeatures, RouteChoice } from "../lib/race-course.ts";
import { raceEffectsAt } from "../lib/race-effects.ts";
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
const branchCourse: CourseFeatures = { junctions: [{
  id: "fork", name: "Test fork", start: 10, end: 20, defaultRoute: "left",
  routes: {
    left: { name: "Left", description: "", speedMultiplier: 1, blockedLanes: [] },
    right: { name: "Right", description: "", speedMultiplier: 1, blockedLanes: [] },
  },
}] };
const branchFrame = (updatedAt: number, redProgress: number, blueProgress: number, redRoute: RouteChoice = "right", blueRoute: RouteChoice = "left") => ({
  ...before, version: 2, course: branchCourse, updatedAt,
  players: {
    red: { progress: redProgress, lane: 1, routeChoices: { fork: redRoute } },
    blue: { progress: blueProgress, lane: 1, routeChoices: { fork: blueRoute } },
  },
});
const splitBefore = branchFrame(1000, 12, 12.5), splitAfter = branchFrame(1500, 14, 14.5);
assert.equal(interpolateRace(splitBefore, splitAfter, 250).players.red.progress, 13, "distinct roads interpolate even when distance/lane overlap");
assert.equal(interpolateRace(splitBefore, splitAfter, 250).players.blue.progress, 13.5);
const defaultBefore = { ...splitBefore, players: { ...splitBefore.players, blue: { progress: 12.5, lane: 1 } } };
const defaultAfter = { ...splitAfter, players: { ...splitAfter.players, blue: { progress: 14.5, lane: 1 } } };
assert.equal(interpolateRace(defaultBefore, defaultAfter, 250).players.red.progress, 13, "implicit default route has the same branch identity");

for (const [label, from, to] of [
  ["same branch", branchFrame(1000, 12, 12.5, "left"), branchFrame(1500, 14, 14.5, "left")],
  ["changed route", branchFrame(1000, 12, 12.5, "left"), splitAfter],
  ["entering split", branchFrame(1000, 9, 9.5), branchFrame(1500, 11, 11.5)],
  ["leaving merge", branchFrame(1000, 19, 19.5), branchFrame(1500, 21, 21.5)],
  ["exact split mouth", branchFrame(1000, 10, 10.5), splitAfter],
  ["exact merge mouth", branchFrame(1000, 18, 18.5), branchFrame(1500, 19.5, 20)],
] as const) {
  assert.equal(interpolateRace(from, to, 250), to, `${label} retains the safe contact fallback`);
}
const changedCourse = { ...splitAfter, course: { junctions: branchCourse.junctions!.map(junction => ({ ...junction, end: 21 })) } };
assert.equal(interpolateRace(splitBefore, changedCourse, 250), changedCourse, "changed branch geometry is not exempt");
console.log("Race presentation: interpolation, contact safety, separate branches, split/merge transitions and phase changes passed");

// A complete short jump can happen between network snapshots. Its retained
// endpoints must replay against the interpolated server clock, not receipt time.
const jumpBefore = { ...before, now: 1000, players: { ...before.players, red: { ...before.players.red, jumpStartedAt: undefined as number | undefined, jumpEndsAt: undefined as number | undefined } } };
const jumpAfter = { ...jumpBefore, updatedAt: 2000, players: { ...jumpBefore.players, red: { ...jumpBefore.players.red, progress: 12, jumpStartedAt: 1100, jumpEndsAt: 1900 } } };
const jumpApex = interpolateRace(jumpBefore, jumpAfter, 500);
assert.equal(jumpApex.now, 1500);
assert.equal(raceEffectsAt(jumpApex.players.red, jumpApex.now!).height, 3.2);
assert.equal(raceEffectsAt(jumpAfter.players.red, 1099).airborne, false);
assert.equal(raceEffectsAt(jumpAfter.players.red, 1900).airborne, false);
assert.equal(raceEffectsAt(jumpAfter.players.red, 1900).height, 0);
assert.equal(raceEffectsAt(jumpAfter.players.red, 1900).landing, 1);

const stopBefore = { ...before, players: { ...before.players, red: { ...before.players.red, spinStartedAt: undefined as number | undefined, spinEndsAt: undefined as number | undefined, spinProgress: undefined as number | undefined, spinLane: undefined as number | undefined } } };
const stopAfter = { ...stopBefore, updatedAt: 3000, players: { ...stopBefore.players, red: { ...stopBefore.players.red, progress: 11.6, lane: 1, spinStartedAt: 1400, spinEndsAt: 2600, spinProgress: 10.8, spinLane: .3 } } };
assert.equal(interpolateRace(stopBefore, stopAfter, 100).players.red.progress, 10.4, "movement approaches the actual impact time");
for (const elapsed of [200, 300, 500, 700, 800]) {
  const frame = interpolateRace(stopBefore, stopAfter, elapsed);
  assert.equal(frame.players.red.progress, 10.8, "progress does not slide through the banana stop");
  assert.equal(frame.players.red.lane, .3, "lane is fixed for the complete spin");
}
assert.equal(interpolateRace(stopBefore, stopAfter, 900).players.red.progress, 11.2, "movement resumes only after spin ends");
assert.equal(raceEffectsAt(stopAfter.players.red, 2000).spinRadians, Math.PI * 3);
assert.equal(raceEffectsAt(stopAfter.players.red, 2000).spinRemainingMs, 600);
assert.equal(raceEffectsAt(stopAfter.players.red, 2600).spinning, false);
for (const phase of ["finished", "cancelled", "lobby", "countdown"]) {
  const jump = raceEffectsAt(jumpAfter.players.red, 1500, phase);
  assert.equal(jump.airborne, false, `${phase} settles an unfinished jump`);
  assert.equal(jump.height, 0);
  assert.equal(jump.jumpRemainingMs, 0);
  assert.equal(raceEffectsAt(jumpAfter.players.red, 1950, phase).landing, 0, `${phase} cannot freeze a landing ring`);
  const spin = raceEffectsAt(stopAfter.players.red, 2000, phase);
  assert.equal(spin.spinning, false, `${phase} settles an unfinished spin`);
  assert.equal(spin.spinRadians, 0);
  assert.equal(spin.spinRemainingMs, 0);
}
const followerBefore = { ...stopBefore, version: 2, course: {}, updatedAt: 5000, players: {
  red: { ...stopBefore.players.red, progress: 10, lane: 0 }, blue: { progress: 7.4, lane: 0 },
} };
const followerAfter = { ...followerBefore, updatedAt: 6500, players: {
  red: { ...followerBefore.players.red, progress: 10.45, spinStartedAt: 5100, spinEndsAt: 6300, spinProgress: 10.25, spinLane: 0 },
  blue: { progress: 8.05, lane: 0 },
} };
for (const elapsed of [0, 100, 400, 600, 800, 1000]) {
  assert.equal(interpolateRace(followerBefore, followerAfter, elapsed), followerAfter,
    "the complete piecewise interval is rejected if a follower would pass through a stopped car");
}
console.log("Race effects: short jump replay, exact landing, stationary spin and post-spin resumption passed");
