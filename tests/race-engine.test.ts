import assert from "node:assert/strict";
import { advance, applyInput, cancelRace, createRace, publicView, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { RaceInput, RaceState } from "../lib/race-engine.ts";

const raceAt = (elapsedMs: number) => RACE_RULES.countdownMs + elapsedMs;

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
assert.equal(RACE_RULES.countdownMs, 5_000, "both ready drivers receive a five-second starting countdown");
const countdown = ready();
assert.equal(advance(countdown, raceAt(-1)).phase, "countdown");
assert.equal(advance(countdown, raceAt(0)).phase, "racing");
assert.equal(advance(countdown, raceAt(1_000)).players.red.progress, 1.8);

// Preparation is only an estimate: a late driver still starts a full countdown.
let lateReady = advance(oneReady, 70_000);
assert.equal(lateReady.phase, "lobby");
assert.equal(lateReady.players.red.progress, 0);
lateReady = applyInput(lateReady, "blue", { type: "join" }, 70_000);
lateReady = applyInput(lateReady, "blue", { type: "ready" }, 70_000);
assert.equal(lateReady.countdownEndsAt, 75_000);
assert.equal(advance(lateReady, 74_999).phase, "countdown");
assert.equal(advance(lateReady, 75_000).phase, "racing");
assert.equal(advance(lateReady, 76_000).players.red.progress, 1.8);
assert.equal(applyInput(lateReady, "blue", { type: "ready" }, 72_000).countdownEndsAt, 75_000, "repeated readiness does not restart the countdown");

const sparse = advance(countdown, raceAt(85_000));
let frequent = countdown;
for (let now = 250; now <= raceAt(85_000); now += 250) frequent = advance(frequent, now);
for (const id of ["red", "blue"] as const) {
  assert.ok(Math.abs(sparse.players[id].progress - frequent.players[id].progress) < 1e-8, "polling frequency must not affect distance");
  assert.equal(sparse.players[id].collisionCount, frequent.players[id].collisionCount, "polling frequency must not affect collisions");
}

let collision = ready("collision");
collision.course.obstacles = [{ id: "collision-fixture", progress: 18, blockedLane: 0 }];
collision = advance(collision, raceAt(10_000));
assert.equal(collision.players.red.progress, 18);
assert.equal(collision.players.red.collisionCount, 1);
assert.equal(collision.players.red.slowedUntil, raceAt(14_000));
collision = advance(collision, raceAt(15_000));
assert.ok(Math.abs(collision.players.red.progress - (18 + 4 * 1.8 * 0.4 + 1.8)) < 1e-8);
assert.equal(collision.players.red.collisionCount, 1, "a gate must not hit twice");

// The gate tests the continuous lane position at the exact crossing instant.
let dodge = ready("dodge");
dodge.course.obstacles = [{ id: "dodge-fixture", progress: 18, blockedLane: 0 }];
dodge = applyInput(dodge, "red", { type: "lane", lane: 1 }, raceAt(9_700));
dodge = advance(dodge, raceAt(10_000));
assert.ok(Math.abs(dodge.players.red.lane - 0.48) < 1e-8);
assert.equal(dodge.players.red.collisionCount, 0, "a car that cleared the lane before the crossing dodges the gate");
let lateDodge = ready("late-dodge");
lateDodge.course.obstacles = [{ id: "late-dodge-fixture", progress: 18, blockedLane: 0 }];
lateDodge = applyInput(lateDodge, "red", { type: "lane", lane: 1 }, raceAt(9_800));
lateDodge = advance(lateDodge, raceAt(10_000));
assert.ok(Math.abs(lateDodge.players.red.lane - 0.32) < 1e-8);
assert.equal(lateDodge.players.red.collisionCount, 1, "changing the target is insufficient if the car still occupies the lane");
let onBoundary = ready("boundary");
onBoundary.course.obstacles = [{ id: "boundary-fixture", progress: 18, blockedLane: 0 }];
onBoundary = applyInput(onBoundary, "red", { type: "lane", lane: 1 }, raceAt(9_718.75));
const boundarySparse = advance(onBoundary, raceAt(10_000));
let boundaryFrequent = onBoundary;
for (let at = raceAt(9_719); at < raceAt(10_000); at++) boundaryFrequent = advance(boundaryFrequent, at);
boundaryFrequent = advance(boundaryFrequent, raceAt(10_000));
assert.equal(boundarySparse.players.red.collisionCount, 1);
assert.equal(boundaryFrequent.players.red.collisionCount, 1, "boundary collision must not depend on floating-point summation from polling");
let sameInstant = ready("instant");
sameInstant.course.obstacles = [{ id: "instant-fixture", progress: 18, blockedLane: 0 }];
sameInstant = applyInput(sameInstant, "red", { type: "lane", lane: 1 }, raceAt(10_000));
assert.equal(sameInstant.players.red.collisionCount, 1, "input at the crossing instant cannot erase a collision that already occurred");

let winner = ready("winner");
winner.course.obstacles = [];
winner = applyInput(winner, "red", { type: "speed", speed: "turbo" }, 0);
winner = advance(winner, 1_000_000);
assert.equal(winner.phase, "finished");
assert.equal(winner.winner, "red");
assert.equal(winner.finishedAt, raceAt(80_000), "late polling must preserve exact first-finish time");
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

const cancelled = cancelRace(countdown, raceAt(5_000));
assert.equal(cancelled.phase, "cancelled");
assert.equal(cancelled.finishReason, "cancelled");
assert.equal(cancelled.finishedAt, raceAt(5_000));
assert.equal(cancelled.winner, null);
assert.equal(cancelled.players.red.progress, 9, "cancellation advances to the requested stop instant");
assert.deepEqual(advance(cancelled, 200_000).players, cancelled.players, "cancelled cars cannot move");
assert.equal(cancelRace(cancelled, 300_000).finishedAt, raceAt(5_000), "repeat stop preserves the first stop time");
assert.equal(publicView(cancelled).remainingMs, 0);
assert.throws(() => applyInput(cancelled, "red", { type: "ready" }, raceAt(15_000)), RaceRuleError);
assert.equal(cancelRace(winner, 2_000_000).winner, "red", "stop after the finish preserves the winner");

console.log("race-engine: deterministic clocks, readiness, collision, first finish, deadline, validation, and view checks passed");
