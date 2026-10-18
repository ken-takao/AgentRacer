import assert from "node:assert/strict";
import test from "node:test";
import { advance, applyInput, cancelRace, createRace, placeObstacle, publicView, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { ObstaclePlacement, RaceInput, RaceState } from "../lib/race-engine.ts";
import { OBSTACLE_ASSETS, getObstacleAsset } from "../lib/obstacle-catalog.ts";

const IDS = ["red", "blue"] as const;
const near = (actual: number, expected: number, tolerance = 0.00001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function running(epoch = 0): RaceState {
  let state = createRace("jump-effects", epoch);
  state.course.obstacles = [];
  state.course.junctions = [];
  for (const id of IDS) {
    state = applyInput(state, id, { type: "join" }, epoch);
    state = applyInput(state, id, { type: "speed", speed: "turbo" }, epoch);
    state = applyInput(state, id, { type: "ready" }, epoch);
  }
  return advance(state, epoch + RACE_RULES.countdownMs);
}
function rejectedWithoutMutation(state: RaceState, operation: () => unknown, pattern?: RegExp): void {
  const before = structuredClone(state);
  assert.throws(operation, pattern ?? RaceRuleError);
  assert.deepEqual(state, before, "a rejected operation must leave source state byte-for-byte unchanged");
}
function poll(state: RaceState, until: number, step = 71): RaceState {
  for (let at = state.updatedAt + step; at < until; at += step) state = advance(state, at);
  return advance(state, until);
}
function compare(a: RaceState, b: RaceState): void {
  assert.equal(a.phase, b.phase);
  assert.equal(a.winner, b.winner);
  for (const id of IDS) {
    near(a.players[id].progress, b.players[id].progress);
    near(a.players[id].lane, b.players[id].lane);
    for (const key of ["collisionCount", "nextObstacleIndex", "spinStartedAt", "spinEndsAt", "jumpStartedAt", "jumpEndsAt"] as const) {
      if (a.players[id][key] === undefined) assert.equal(b.players[id][key], undefined);
      else near(a.players[id][key]!, b.players[id][key]!);
    }
  }
  assert.deepEqual(a.history.map(event => ({ ...event, at: Math.round(event.at * 1000) / 1000 })), b.history.map(event => ({ ...event, at: Math.round(event.at * 1000) / 1000 })));
}

test("catalog exposes exactly manifest obstacles and only local asset URLs", () => {
  assert.equal(OBSTACLE_ASSETS.length, 9);
  assert.ok(OBSTACLE_ASSETS.every(asset => asset.kind === "obstacle" && asset.glbUrl === `/roadster-circuit/props/${asset.glb}` && asset.topUrl.endsWith("_top.png")));
  assert.equal(getObstacleAsset("banana_peel")?.effect, "spin");
  assert.equal(getObstacleAsset("boost_pad"), undefined);
  assert.equal(getObstacleAsset("../secret"), undefined);
});

test("jump is 800 ms, landing starts a 2 s cooldown, spam and invalid phases change no state", () => {
  const initial = running();
  assert.equal(publicView(initial).players.red.jumpAvailable, true);
  let state = applyInput(initial, "red", { type: "jump" }, initial.updatedAt);
  assert.equal(state.players.red.jumpStartedAt, 5000);
  assert.equal(state.players.red.jumpEndsAt, 5800);
  assert.equal(state.players.red.jumpReadyAt, 7800);
  assert.equal(publicView(state).players.red.jumpAvailable, false);
  for (const at of [5000, 5001, 5799, 5800, 7799]) {
    rejectedWithoutMutation(state, () => applyInput(state, "red", { type: "jump" }, at));
  }
  const landed = advance(state, 5800);
  assert.equal(publicView(landed).players.red.jumpCooldownRemainingMs, 2000);
  assert.equal(landed.history.filter(event => event.type === "jump_landed").length, 1);
  assert.equal(landed.players.red.jumpStartedAt, 5000, "retain effect endpoints for interpolation");
  state = advance(landed, 7800);
  assert.equal(publicView(state).players.red.jumpAvailable, true);
  state = applyInput(state, "red", { type: "jump" }, 7800);
  assert.equal(state.history.filter(event => event.type === "jump_started").length, 2);
  const lobby = applyInput(createRace("lobby", 0), "red", { type: "join" }, 0);
  rejectedWithoutMutation(lobby, () => applyInput(lobby, "red", { type: "jump" }, 0));
  let countdown = applyInput(lobby, "blue", { type: "join" }, 0);
  countdown = applyInput(countdown, "red", { type: "ready" }, 0);
  countdown = applyInput(countdown, "blue", { type: "ready" }, 0);
  rejectedWithoutMutation(countdown, () => applyInput(countdown, "red", { type: "jump" }, 4999));
  const finished = advance(initial, initial.updatedAt + 180000);
  rejectedWithoutMutation(finished, () => applyInput(finished, "red", { type: "jump" }, finished.updatedAt));
  const cancelled = cancelRace(initial, initial.updatedAt);
  rejectedWithoutMutation(cancelled, () => applyInput(cancelled, "red", { type: "jump" }, cancelled.updatedAt));
  const legacy = { ...initial, version: 1 as const };
  rejectedWithoutMutation(legacy, () => applyInput(legacy, "red", { type: "jump" }, legacy.updatedAt));
});

test("airborne crossings avoid obstacles including banana, but landing boundary collides", () => {
  const source = running();
  source.course.obstacles = [
    { id: "air-cone", progress: 0.5, blockedLane: 0, assetId: "traffic_cone" },
    { id: "air-banana", progress: 1.25, blockedLane: 0, assetId: "banana_peel" },
    { id: "landing-banana", progress: 2, blockedLane: 0, assetId: "banana_peel" },
  ];
  const jumping = applyInput(source, "red", { type: "jump" }, source.updatedAt);
  const airborne = advance(jumping, 5799);
  assert.equal(airborne.players.red.collisionCount, 0);
  assert.equal(airborne.players.red.spinStartedAt, undefined);
  assert.equal(airborne.history.filter(event => event.type === "obstacle_avoided").length, 2);
  const landed = advance(jumping, 5800);
  assert.equal(landed.players.red.collisionCount, 1);
  assert.equal(landed.players.red.spinStartedAt, 5800);
  near(landed.players.red.progress, 2);
  const after = advance(jumping, 9000);
  assert.equal(after.players.red.collisionCount, 1, "passed gates never collide twice");
  compare(after, poll(jumping, 9000));
});

test("banana stops exactly at impact for 1200 ms, queues controls, then resumes once", () => {
  let state = running();
  state.course.obstacles = [{ id: "banana", progress: 1.25, blockedLane: 0, assetId: "banana_peel" }];
  state = advance(state, 5600);
  near(state.players.red.progress, 1.25);
  assert.equal(state.players.red.spinStartedAt, 5500);
  assert.equal(state.players.red.spinEndsAt, 6700);
  assert.equal(state.players.red.spinProgress, 1.25);
  assert.equal(state.players.red.spinLane, 0);
  assert.equal(publicView(state).players.red.speed, 0);
  assert.equal(publicView(state).players.red.spinRemainingMs, 1100);
  assert.equal(publicView(state).players.red.jumpAvailable, false);
  rejectedWithoutMutation(state, () => applyInput(state, "red", { type: "jump" }, 6000));
  state = applyInput(state, "red", { type: "lane", lane: 1 }, 6000);
  state = applyInput(state, "red", { type: "speed", speed: "normal" }, 6000);
  assert.equal(state.players.red.targetLane, 1);
  assert.equal(state.players.red.speedMode, "normal");
  assert.equal(publicView(state).players.red.laneVelocity, 0);
  state = advance(state, 6700);
  near(state.players.red.progress, 1.25);
  near(state.players.red.lane, 0);
  assert.equal(publicView(state).players.red.spinRemainingMs, 0);
  state = advance(state, 6800);
  near(state.players.red.progress, 1.43);
  near(state.players.red.lane, 0.16);
  state = advance(state, 10000);
  assert.equal(state.players.red.collisionCount, 1);
  assert.equal(state.history.filter(event => event.type === "spin_started").length, 1);
  assert.equal(state.history.filter(event => event.type === "spin_ended").length, 1);
});

test("stopped banana car remains anchored when hit from the side or rear", () => {
  const side = running();
  Object.assign(side.players.red, { progress: 10, lane: 1, targetLane: 0, spinStartedAt: 5000, spinEndsAt: 6200, spinProgress: 10, spinLane: 1 });
  Object.assign(side.players.blue, { progress: 10, lane: 2, targetLane: 1 });
  const sideHit = advance(side, 5300);
  near(sideHit.players.red.progress, 10);
  near(sideHit.players.red.lane, 1);
  assert.equal(sideHit.players.red.carCollisions, 1);
  assert.ok(sideHit.players.blue.lane >= 1.7 - 0.00001);
  const rear = running();
  Object.assign(rear.players.red, { progress: 4, lane: 0, targetLane: 1, spinStartedAt: 5000, spinEndsAt: 6200, spinProgress: 4, spinLane: 0 });
  Object.assign(rear.players.blue, { progress: 0, lane: 0, targetLane: 0 });
  const rearHit = advance(rear, 6000);
  near(rearHit.players.red.progress, 4);
  near(rearHit.players.red.lane, 0);
  near(rearHit.players.blue.progress, 4 - RACE_RULES.carLength);
});

test("sparse and frequent polling agree across jump, spin and both zero speeds at Unix epochs", () => {
  for (const epoch of [0, 1729200000000]) {
    const state = running(epoch);
    state.course.obstacles = [
      { id: "air", progress: 1, blockedLane: 0, assetId: "banana_peel" },
      { id: "spin-red", progress: 3, blockedLane: 0, assetId: "banana_peel" },
      { id: "spin-blue", progress: 3, blockedLane: 2, assetId: "banana_peel" },
      { id: "cone", progress: 8, blockedLane: 0, assetId: "traffic_cone" },
    ];
    const jumping = applyInput(state, "red", { type: "jump" }, state.updatedAt);
    compare(advance(jumping, state.updatedAt + 7000), poll(jumping, state.updatedAt + 7000));
  }
});

test("dynamic insertion preserves crossed gates and skipped-fork cursors", () => {
  const source = running();
  source.course.junctions = [{ id: "fork", name: "TEST", start: 20, end: 40, defaultRoute: "left", routes: {
    left: { name: "LEFT", description: "", speedMultiplier: 1, blockedLanes: [] },
    right: { name: "RIGHT", description: "", speedMultiplier: 1, blockedLanes: [] },
  } }];
  source.course.obstacles = [
    { id: "skipped-before", progress: 24, blockedLane: 0, junctionId: "fork", route: "right" },
    { id: "crossed", progress: 28, blockedLane: 0, junctionId: "fork", route: "left" },
    { id: "skipped-after", progress: 32, blockedLane: 0, junctionId: "fork", route: "right" },
    { id: "later", progress: 50, blockedLane: 0 },
  ];
  const before = advance(source, 17000);
  assert.equal(before.players.red.nextObstacleIndex, 2);
  assert.equal(before.players.red.collisionCount, 1);
  const placed = placeObstacle(before, { assetId: "banana_peel", lane: 0, progress: 45 }, 17000, "inserted");
  assert.deepEqual(before.course.obstacles.map(obstacle => obstacle.id), ["skipped-before", "crossed", "skipped-after", "later"], "successful reducer also leaves its source immutable");
  assert.deepEqual(placed.course.obstacles.map(obstacle => obstacle.id), ["skipped-before", "crossed", "skipped-after", "inserted", "later"]);
  assert.equal(placed.players.red.nextObstacleIndex, 2);
  const after = advance(placed, 45000);
  assert.deepEqual(after.history.filter(event => event.playerId === "red" && event.type === "collision").map(event => event.obstacleId), ["crossed", "inserted", "later"]);
  compare(after, poll(placed, 45000));
  const event = placed.history.find(event => event.type === "obstacle_placed");
  assert.equal(event?.assetId, "banana_peel");
  assert.equal(event?.progress, 45);
  assert.equal(event?.obstacleId, "inserted");
});

test("placement validation is atomic: ranges, leading car, manifest, branches, spacing and rate", () => {
  const source = running();
  const valid: ObstaclePlacement = { assetId: "traffic_cone", lane: 1, progress: 20 };
  for (const input of [
    { ...valid, assetId: "boost_pad" }, { ...valid, assetId: "unknown" },
    { ...valid, lane: 3 }, { ...valid, lane: "1" },
    { ...valid, progress: NaN }, { ...valid, progress: Infinity },
    { ...valid, progress: -1 }, { ...valid, progress: 198 },
    { ...valid, progress: 11.99 }, { ...valid, route: "left" },
  ]) rejectedWithoutMutation(source, () => placeObstacle(source, input as ObstaclePlacement, 5000, "invalid"));
  const delayed = { ...valid, progress: 12 };
  rejectedWithoutMutation(source, () => placeObstacle(source, delayed, 6000, "late"), /12以上/);
  const placed = placeObstacle(source, { ...valid, progress: 12 }, 5000, "first");
  assert.equal(placed.placedObstacleCount, 1);
  rejectedWithoutMutation(placed, () => placeObstacle(placed, { ...valid, progress: 30 }, 6499, "too-soon"), /1.5秒/);
  rejectedWithoutMutation(placed, () => placeObstacle(placed, { ...valid, progress: 15.99 }, 6500, "overlap"), /4以上/);
  const spaced = placeObstacle(placed, { ...valid, progress: 16 }, 6500, "spaced");
  assert.equal(spaced.placedObstacleCount, 2);
  rejectedWithoutMutation(spaced, () => placeObstacle(spaced, { ...valid, progress: 40 }, 8000, "first"), /識別子/);
  for (const state of [createRace("lobby", 0), cancelRace(source, 5000), advance(source, 200000), { ...source, version: 1 as const }]) {
    rejectedWithoutMutation(state, () => placeObstacle(state, valid, state.updatedAt, "phase"));
  }
  const branches = running();
  branches.course.junctions = [{ id: "fork", name: "FORK", start: 20, end: 40, defaultRoute: "left", routes: {
    left: { name: "LEFT", description: "", speedMultiplier: 1, blockedLanes: [] },
    right: { name: "RIGHT", description: "", speedMultiplier: 1, blockedLanes: [] },
  } }];
  rejectedWithoutMutation(branches, () => placeObstacle(branches, { ...valid, progress: 25 }, 5000, "unspecified"), /分岐/);
  const left = placeObstacle(branches, { ...valid, progress: 25, route: "left" }, 5000, "left");
  const right = placeObstacle(left, { ...valid, progress: 25, route: "right" }, 6500, "right");
  assert.equal(right.course.obstacles.length, 2, "opposite branches may have the same progress and lane");
  assert.equal(right.course.obstacles[1].junctionId, "fork", "the server derives the branch identity");
  rejectedWithoutMutation(right, () => placeObstacle(right, { ...valid, progress: 25, route: "left" }, 8000, "left-again"), /4以上/);
});

test("human obstacle cap survives bounded history and rejects the 21st placement", () => {
  let state = running();
  for (let index = 0; index < 20; index++) {
    state = placeObstacle(state, { assetId: "traffic_cone", lane: index % 3 as 0 | 1 | 2, progress: 100 + Math.floor(index / 3) * 4 }, 5000 + index * 1500, `placed-${index}`);
  }
  assert.equal(state.placedObstacleCount, 20);
  state.history = [];
  rejectedWithoutMutation(state, () => placeObstacle(state, { assetId: "banana_peel", lane: 0, progress: 160 }, 35000, "overflow"), /20個/);
});

test("placement and driver commands at the same instant preserve each other's state", () => {
  const state = running();
  for (const command of [{ type: "jump" }, { type: "lane", lane: 1 }, { type: "speed", speed: "slow" }] as RaceInput[]) {
    const placement = { assetId: "banana_peel", lane: 0 as const, progress: 20 };
    const driveThenPlace = placeObstacle(applyInput(state, "red", command, 6000), placement, 6000, "concurrent");
    const placeThenDrive = applyInput(placeObstacle(state, placement, 6000, "concurrent"), "red", command, 6000);
    assert.deepEqual(driveThenPlace.players, placeThenDrive.players);
    assert.deepEqual(driveThenPlace.course, placeThenDrive.course);
    assert.equal(driveThenPlace.placedObstacleCount, 1);
    assert.equal(placeThenDrive.placedObstacleCount, 1);
  }
});
