import assert from "node:assert/strict";
import { advance, applyInput, cancelRace, createRace, publicView, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { RaceInput, RaceState } from "../lib/race-engine.ts";

function ready(seed = "test"): RaceState {
  let state = createRace(seed, 0);
  for (const id of ["red", "blue"] as const) {
    state = applyInput(state, id, { type: "join" }, 0);
    state = applyInput(state, id, { type: "ready" }, 0);
  }
  return state;
}

assert.deepEqual(createRace("fixed-seed", 0), createRace("fixed-seed", 0));
assert.notDeepEqual(createRace("fixed-seed", 0).course, createRace("another-seed", 0).course);

const source = createRace("immutable", 0);
const unchanged = structuredClone(source);
const joined = applyInput(source, "red", { type: "join" }, 0);
assert.deepEqual(source, unchanged, "input must not mutate its source");
assert.equal(joined.players.red.joined, true);
assert.throws(() => applyInput(source, "red", { type: "ready" }, 0), RaceRuleError);
assert.throws(() => applyInput(joined, "red", { type: "lane", lane: 9 } as unknown as RaceInput, 0), RaceRuleError);

const oneReady = applyInput(joined, "red", { type: "ready" }, 0);
assert.equal(advance(oneReady, 1_000_000).phase, "lobby", "one driver must not start the race");
const countdown = ready();
assert.equal(advance(countdown, 14_999).phase, "countdown");
assert.equal(advance(countdown, 15_000).phase, "racing");
assert.equal(advance(countdown, 16_000).players.red.progress, 1.8);

const sparse = advance(countdown, 100_000);
let frequent = countdown;
for (let now = 250; now <= 100_000; now += 250) frequent = advance(frequent, now);
for (const id of ["red", "blue"] as const) {
  assert.ok(Math.abs(sparse.players[id].progress - frequent.players[id].progress) < 1e-8, "polling frequency must not affect distance");
  assert.equal(sparse.players[id].collisionCount, frequent.players[id].collisionCount, "polling frequency must not affect collisions");
}

let collision = ready("collision");
collision.course.obstacles = [{ id: "collision-fixture", progress: 18, blockedLane: 0 }];
collision = advance(collision, 25_000);
assert.equal(collision.players.red.progress, 18);
assert.equal(collision.players.red.collisionCount, 1);
assert.equal(collision.players.red.slowedUntil, 29_000);
collision = advance(collision, 30_000);
assert.ok(Math.abs(collision.players.red.progress - (18 + 4 * 1.8 * 0.4 + 1.8)) < 1e-8);
assert.equal(collision.players.red.collisionCount, 1, "a gate must not hit twice");

// The gate tests the continuous lane position at the exact crossing instant.
let dodge = ready("dodge");
dodge.course.obstacles = [{ id: "dodge-fixture", progress: 18, blockedLane: 0 }];
dodge = applyInput(dodge, "red", { type: "lane", lane: 1 }, 24_700);
dodge = advance(dodge, 25_000);
assert.ok(Math.abs(dodge.players.red.lane - 0.48) < 1e-8);
assert.equal(dodge.players.red.collisionCount, 0, "a car that cleared the lane before the crossing dodges the gate");
let lateDodge = ready("late-dodge");
lateDodge.course.obstacles = [{ id: "late-dodge-fixture", progress: 18, blockedLane: 0 }];
lateDodge = applyInput(lateDodge, "red", { type: "lane", lane: 1 }, 24_800);
lateDodge = advance(lateDodge, 25_000);
assert.ok(Math.abs(lateDodge.players.red.lane - 0.32) < 1e-8);
assert.equal(lateDodge.players.red.collisionCount, 1, "changing the target is insufficient if the car still occupies the lane");
let onBoundary = ready("boundary");
onBoundary.course.obstacles = [{ id: "boundary-fixture", progress: 18, blockedLane: 0 }];
onBoundary = applyInput(onBoundary, "red", { type: "lane", lane: 1 }, 24_718.75);
const boundarySparse = advance(onBoundary, 25_000);
let boundaryFrequent = onBoundary;
for (let at = 24_719; at < 25_000; at++) boundaryFrequent = advance(boundaryFrequent, at);
boundaryFrequent = advance(boundaryFrequent, 25_000);
assert.equal(boundarySparse.players.red.collisionCount, 1);
assert.equal(boundaryFrequent.players.red.collisionCount, 1, "boundary collision must not depend on floating-point summation from polling");
let sameInstant = ready("instant");
sameInstant.course.obstacles = [{ id: "instant-fixture", progress: 18, blockedLane: 0 }];
sameInstant = applyInput(sameInstant, "red", { type: "lane", lane: 1 }, 25_000);
assert.equal(sameInstant.players.red.collisionCount, 1, "input at the crossing instant cannot erase a collision that already occurred");

let winner = ready("winner");
winner.course.obstacles = [];
winner = applyInput(winner, "red", { type: "speed", speed: "turbo" }, 0);
winner = advance(winner, 1_000_000);
assert.equal(winner.phase, "finished");
assert.equal(winner.winner, "red");
assert.equal(winner.finishedAt, 95_000, "late polling must preserve exact first-finish time");
assert.equal(winner.players.blue.progress, 144, "the loser stops when the winner finishes");

let limit = ready("deadline");
limit.course.obstacles = [];
for (const id of ["red", "blue"] as const) limit = applyInput(limit, id, { type: "speed", speed: "slow" }, 0);
limit = advance(limit, 1_000_000);
assert.equal(limit.finishReason, "time_limit");
assert.equal(limit.finishedAt, RACE_RULES.countdownMs + RACE_RULES.maxRaceMs);
assert.equal(limit.winner, "tie");
assert.equal(limit.players.red.progress, 180);

const view = publicView(sparse);
assert.equal("nextObstacleIndex" in view.players.red, false);
assert.ok(view.players.red.upcomingObstacles.every((o) => o.progress > view.players.red.progress && o.progress <= view.players.red.progress + 60));
view.players.red.progress = -1;
assert.notEqual(sparse.players.red.progress, -1, "public view must not alias mutable engine state");
assert.equal(advance(sparse, 0).updatedAt, sparse.updatedAt, "stale clocks cannot rewind a race");

const cancelled = cancelRace(countdown, 20_000);
assert.equal(cancelled.phase, "cancelled");
assert.equal(cancelled.finishReason, "cancelled");
assert.equal(cancelled.finishedAt, 20_000);
assert.equal(cancelled.winner, null);
assert.equal(cancelled.players.red.progress, 9, "cancellation advances to the requested stop instant");
assert.deepEqual(advance(cancelled, 200_000).players, cancelled.players, "cancelled cars cannot move");
assert.equal(cancelRace(cancelled, 300_000).finishedAt, 20_000, "repeat stop preserves the first stop time");
assert.equal(publicView(cancelled).remainingMs, 0);
assert.throws(() => applyInput(cancelled, "red", { type: "ready" }, 30_000), RaceRuleError);
assert.equal(cancelRace(winner, 2_000_000).winner, "red", "stop after the finish preserves the winner");

console.log("race-engine: deterministic clocks, readiness, collision, first finish, deadline, validation, and view checks passed");
