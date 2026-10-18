import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { advance, applyInput, createRace, publicView, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { RaceState } from "../lib/race-engine.ts";
import { selectedRoute } from "../lib/race-course.ts";
import type { CourseJunction } from "../lib/race-course.ts";

const near = (a: number, b: number, tolerance = 0.000002) => assert.ok(Math.abs(a - b) < tolerance, `${a} must equal ${b}`);
const IDS = ["red", "blue"] as const;
function running(epoch = 0): RaceState {
  let state = createRace("interactions", epoch);
  state.course.obstacles = [];
  state.course.junctions = [];
  for (const id of IDS) {
    state = applyInput(state, id, { type: "join" }, epoch);
    state = applyInput(state, id, { type: "ready" }, epoch);
  }
  return advance(state, epoch + RACE_RULES.countdownMs);
}
function poll(state: RaceState, duration: number, step = 137): RaceState {
  const start = state.updatedAt;
  const end = start + duration;
  for (let at = start + step; at < end; at += step) state = advance(state, at);
  return advance(state, end);
}
function compare(a: RaceState, b: RaceState): void {
  assert.equal(a.phase, b.phase);
  assert.equal(a.winner, b.winner);
  for (const id of IDS) {
    near(a.players[id].progress, b.players[id].progress);
    near(a.players[id].lane, b.players[id].lane);
    assert.equal(a.players[id].collisionCount, b.players[id].collisionCount);
    assert.equal(a.players[id].carCollisions, b.players[id].carCollisions);
    assert.deepEqual(a.players[id].routeChoices, b.players[id].routeChoices);
  }
}
function rearEnd(epoch = 0): RaceState {
  const state = running(epoch);
  for (const id of IDS) state.players[id].lane = state.players[id].targetLane = 1;
  state.players.blue.progress = 8;
  state.players.red.speedMode = "turbo";
  state.players.blue.speedMode = "slow";
  return state;
}

// A faster car catches the rear bumper at an exact continuous time and must
// stay behind until it changes lane. Both cars receive the same impact penalty.
const rear = rearEnd();
const hitTime = rear.updatedAt + (8 - RACE_RULES.carLength) / 1.5 * 1000;
const impact = advance(rear, hitTime + 1);
for (const id of IDS) {
  assert.equal(impact.players[id].carCollisions, 1);
  near(impact.players[id].lastCarCollisionAt!, hitTime);
  near(impact.players[id].slowedUntil, hitTime + RACE_RULES.collisionSlowMs);
}
const following = advance(rear, rear.updatedAt + 15_000);
near(following.players.blue.progress - following.players.red.progress, RACE_RULES.carLength);
near(publicView(following).players.red.speed, publicView(following).players.blue.speed);
assert.equal(following.history.filter(e => e.type === "car_collision").length, 1);
compare(following, poll(rear, 15_000));
assert.equal("carContact" in publicView(following), false, "private contact state is not exposed");
let sameInstantCommands = applyInput(following, "blue", { type: "speed", speed: "turbo" }, following.updatedAt);
sameInstantCommands = applyInput(sameInstantCommands, "blue", { type: "speed", speed: "slow" }, following.updatedAt);
sameInstantCommands = advance(sameInstantCommands, following.updatedAt + 1);
assert.equal(sameInstantCommands.players.red.carCollisions, 1, "input intent without physical separation cannot farm another collision");
let overtaking = applyInput(following, "red", { type: "lane", lane: 0 }, following.updatedAt);
overtaking = advance(overtaking, overtaking.updatedAt + 10_000);
assert.ok(overtaking.players.red.progress > overtaking.players.blue.progress, "an unobstructed lane enables a real pass");
assert.equal(overtaking.players.red.carCollisions, 1, "steering away does not count another impact");

// Collision is symmetric when vehicle identities and the front/rear positions swap.
const mirrored = rearEnd();
[mirrored.players.red.progress, mirrored.players.blue.progress] = [mirrored.players.blue.progress, mirrored.players.red.progress];
[mirrored.players.red.speedMode, mirrored.players.blue.speedMode] = [mirrored.players.blue.speedMode, mirrored.players.red.speedMode];
const mirrorResult = advance(mirrored, mirrored.updatedAt + 15_000);
near(mirrorResult.players.red.progress, following.players.blue.progress);
near(mirrorResult.players.blue.progress, following.players.red.progress);

// Both lane changes cross between polls. The swept rectangles meet halfway;
// neither car teleports through the other and repeated polls do not farm hits.
let sides = running();
sides.players.red.progress = sides.players.blue.progress = 10;
sides = applyInput(sides, "red", { type: "lane", lane: 2 }, sides.updatedAt);
sides = applyInput(sides, "blue", { type: "lane", lane: 0 }, sides.updatedAt);
const sidesResult = advance(sides, sides.updatedAt + 10_000);
near(sidesResult.players.blue.lane - sidesResult.players.red.lane, RACE_RULES.carWidth);
assert.ok(sidesResult.players.red.lane < sidesResult.players.blue.lane);
assert.equal(sidesResult.players.red.carCollisions, 1);
assert.equal(sidesResult.players.blue.carCollisions, 1);
assert.equal(publicView(sidesResult).players.red.laneVelocity, 0);
assert.equal(publicView(sidesResult).players.blue.laneVelocity, 0);
near(sidesResult.players.red.lastCarCollisionAt!, sides.updatedAt + (2 - RACE_RULES.carWidth) / 3.2 * 1000);
compare(sidesResult, poll(sides, 10_000, 61));

// Continuing forward clears a side-by-side block; passing in distinct lanes
// never generates contact solely because the progress values cross.
const adjacent = rearEnd();
adjacent.players.red.lane = adjacent.players.red.targetLane = 0;
adjacent.players.blue.lane = adjacent.players.blue.targetLane = 2;
const clearPass = advance(adjacent, adjacent.updatedAt + 20_000);
assert.ok(clearPass.players.red.progress > clearPass.players.blue.progress);
assert.equal(clearPass.players.red.carCollisions, 0);
const initialOverlap = running();
initialOverlap.players.red.lane = initialOverlap.players.blue.lane = 0;
initialOverlap.players.red.targetLane = initialOverlap.players.blue.targetLane = 0;
const separated = advance(initialOverlap, initialOverlap.updatedAt + 1_000);
near(Math.abs(separated.players.red.lane - separated.players.blue.lane), RACE_RULES.carWidth);
assert.ok(separated.players.red.progress >= 0 && separated.players.blue.progress >= 0);
assert.equal(separated.players.red.carCollisions, 1);

const fork: CourseJunction = {
  id: "test-fork", name: "TEST", start: 20, end: 50, defaultRoute: "right",
  routes: {
    left: { name: "FAST", description: "Fast", speedMultiplier: 1.2, blockedLanes: [0, 1] },
    right: { name: "SAFE", description: "Safe", speedMultiplier: 0.8, blockedLanes: [] },
  },
};
function branching(epoch = 0): RaceState {
  const state = running(epoch);
  state.course.junctions = [structuredClone(fork)];
  state.players.red.speedMode = state.players.blue.speedMode = "turbo";
  return state;
}
let branch = branching();
branch = applyInput(branch, "red", { type: "route", junctionId: fork.id, route: "left" }, branch.updatedAt);
const entered = advance(branch, branch.updatedAt + 8_000);
assert.equal(entered.players.red.progress, 20);
assert.equal(entered.players.blue.routeChoices?.[fork.id], "right", "default choice is fixed at entry");
assert.throws(() => applyInput(entered, "red", { type: "route", junctionId: fork.id, route: "right" }, entered.updatedAt), RaceRuleError);
assert.throws(() => applyInput(branch, "red", { type: "route", junctionId: "missing", route: "left" }, branch.updatedAt), RaceRuleError);
const branchFinish = advance(branch, branch.updatedAt + 150_000);
near(branchFinish.finishedAt!, branch.updatedAt + 78_000);
assert.equal(branchFinish.winner, "red", "branch choice changes the real finishing time");
compare(branchFinish, poll(branch, 150_000, 131));
assert.ok(branchFinish.history.some(e => e.type === "route_entered" && e.route === "left"));

// Equal progress/lane is safe on separate road branches. A merged road is shared
// again and overlapping cars are physically separated with one collision.
const separate = branching();
separate.course.junctions![0].routes.left.speedMultiplier = separate.course.junctions![0].routes.right.speedMultiplier = 1;
for (const id of IDS) {
  separate.players[id].progress = 30;
  separate.players[id].lane = separate.players[id].targetLane = 1;
}
separate.players.red.routeChoices = { [fork.id]: "left" };
separate.players.blue.routeChoices = { [fork.id]: "right" };
const beforeMerge = advance(separate, separate.updatedAt + 7_000);
assert.equal(beforeMerge.players.red.carCollisions, 0);
assert.equal(beforeMerge.players.blue.carCollisions, 0);
const afterMerge = advance(separate, separate.updatedAt + 10_000);
const atMerge = advance(separate, separate.updatedAt + 8_000);
assert.equal(atMerge.players.red.carCollisions, 1, "contact is settled on the exact merge boundary");
assert.equal(afterMerge.players.red.carCollisions, 1);
assert.equal(afterMerge.players.blue.carCollisions, 1);
near(Math.abs(afterMerge.players.red.lane - afterMerge.players.blue.lane), RACE_RULES.carWidth);
compare(afterMerge, poll(separate, 10_000, 113));
const closeMerge = structuredClone(separate);
closeMerge.players.red.progress = fork.end - 0.1;
closeMerge.players.blue.progress = fork.end - 0.15;
const closeMergeResult = advance(closeMerge, closeMerge.updatedAt + 500);
for (const id of IDS) {
  assert.ok(closeMergeResult.players[id].progress >= closeMerge.players[id].progress, "merge collision must not rewind a car");
  assert.equal(closeMergeResult.players[id].carCollisions, 1);
}
compare(closeMergeResult, poll(closeMerge, 500, 23));

const hazards = branching();
hazards.course.obstacles = [{ id: "branch-hazard", junctionId: fork.id, route: "left", progress: 30, blockedLane: 0 }];
for (const id of IDS) hazards.players[id].lane = hazards.players[id].targetLane = 0;
hazards.players.red.progress = hazards.players.blue.progress = 21;
hazards.players.red.routeChoices = { [fork.id]: "left" };
hazards.players.blue.routeChoices = { [fork.id]: "right" };
const hazardsView = publicView(hazards);
assert.equal(hazardsView.players.red.upcomingObstacles.length, 1);
assert.equal(hazardsView.players.blue.upcomingObstacles.length, 0);
assert.equal(hazardsView.course.obstacles.length, 1, "the spectator can render hazards on both branches");
hazards.course.obstacles.push({ id: "distant-hazard", progress: 180, blockedLane: 2 });
assert.equal(publicView(hazards).course.obstacles.length, 2, "the spectator receives the full v2 obstacle map");
const hazardResult = advance(hazards, hazards.updatedAt + 5_000);
assert.equal(hazardResult.players.red.collisionCount, 1);
assert.equal(hazardResult.players.blue.collisionCount, 0);
compare(hazardResult, poll(hazards, 5_000, 173));

const generated = createRace("generated-course", 0);
assert.equal(generated.version, 2);
assert.equal(generated.course.junctions?.length, 2);
for (const junction of generated.course.junctions!) {
  for (const route of ["left", "right"] as const) {
    assert.equal(generated.course.obstacles.filter(o => o.junctionId === junction.id && o.route === route).length, junction.routes[route].blockedLanes.length);
  }
  assert.ok(generated.course.obstacles.filter(o => !o.junctionId).every(o => o.progress < junction.start || o.progress >= junction.end));
  assert.equal(junction.routes[selectedRoute(junction, generated.players.red)].blockedLanes.length, 0);
}
const copyView = publicView(generated);
copyView.course.junctions![0].routes.left.blockedLanes.push(2);
copyView.players.red.routeChoices!.anything = "left";
assert.notDeepEqual(copyView.course.junctions, generated.course.junctions);
assert.equal(generated.players.red.routeChoices?.anything, undefined);

// Keep Unix-time and generated-course progress bounded in an OS-timed child.
if (!process.argv.includes("--bounded-regressions")) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--bounded-regressions"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined, `v2 simulation must terminate: ${child.error?.message}`);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
} else {
  const epoch = 1_792_304_000_000;
  for (let seed = 0; seed < 20; seed++) {
    let state = createRace(seed, epoch);
    for (const id of IDS) {
      state = applyInput(state, id, { type: "join" }, epoch);
      state = applyInput(state, id, { type: "ready" }, epoch);
      state = applyInput(state, id, { type: "speed", speed: id === "red" ? "turbo" : "normal" }, epoch);
      for (const junction of state.course.junctions!) state = applyInput(state, id, { type: "route", junctionId: junction.id, route: id === "red" ? "left" : "right" }, epoch);
    }
    compare(advance(state, epoch + 200_000), poll(state, 200_000, 401));
  }
  const epochRear = rearEnd(epoch);
  compare(advance(epochRear, epochRear.updatedAt + 150_000), poll(epochRear, 150_000));
}
console.log("race-interaction: swept rear/side contacts, release, route locks/speeds/hazards/merge, legacy separation, and bounded Unix-clock polling passed");
