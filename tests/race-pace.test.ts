import assert from "node:assert/strict";
import test from "node:test";
import { advance, applyInput, createRace, placeObstacle, publicView, racePaceRules, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { RacePace, RaceState, SpeedMode } from "../lib/race-engine.ts";
import { placementView } from "../operator/obstacles.mjs";

const IDS = ["red", "blue"] as const;
const near = (actual: number, expected: number, tolerance = 0.00001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function running(pace?: RacePace, mode: SpeedMode = "normal", epoch = 0): RaceState {
  let state = createRace("pace-test", epoch, { pace });
  state.course.obstacles = [];
  state.course.junctions = [];
  for (const id of IDS) {
    state = applyInput(state, id, { type: "join" }, epoch);
    state = applyInput(state, id, { type: "speed", speed: mode }, epoch);
    state = applyInput(state, id, { type: "ready" }, epoch);
  }
  return advance(state, epoch + 5000);
}
function polled(state: RaceState, until: number): RaceState {
  for (let at = state.updatedAt + 71; at < until; at += 71) state = advance(state, at);
  return advance(state, until);
}
function sameOutcome(a: RaceState, b: RaceState) {
  assert.equal(a.phase, b.phase);
  assert.equal(a.winner, b.winner);
  if (a.finishedAt !== null) near(a.finishedAt, b.finishedAt!);
  for (const id of IDS) {
    near(a.players[id].progress, b.players[id].progress);
    near(a.players[id].lane, b.players[id].lane);
    assert.equal(a.players[id].collisionCount, b.players[id].collisionCount);
    assert.equal(a.players[id].carCollisions, b.players[id].carCollisions);
    assert.equal(a.players[id].nextObstacleIndex, b.players[id].nextObstacleIndex);
    assert.deepEqual(a.players[id].routeChoices, b.players[id].routeChoices);
  }
  const rounded = (state: RaceState) => state.history.map(event => ({ ...event, at: Math.round(event.at * 1000) / 1000 }));
  assert.deepEqual(rounded(a), rounded(b));
}

test("pace is opt-in, persists through JSON, and missing v1/v2 fields retain classic movement", () => {
  assert.equal(Object.hasOwn(createRace("default", 0), "pace"), false);
  for (const invalid of ["turbo", "classic", 2, null, {}]) {
    assert.throws(() => createRace("invalid", 0, { pace: invalid as RacePace }), RaceRuleError);
  }
  for (const version of [1, 2] as const) {
    const state = JSON.parse(JSON.stringify(running())) as RaceState;
    state.version = version;
    assert.deepEqual(racePaceRules(state), { speedMultiplier: 1, visibleDistance: 60, placementAhead: 12 });
    near(advance(state, 6000).players.red.progress, 1.8);
  }
  const sprint = JSON.parse(JSON.stringify(running("sprint-2x"))) as RaceState;
  assert.equal(sprint.pace, "sprint-2x");
  near(advance(sprint, 6000).players.red.progress, 3.6);
  sprint.version = 1;
  near(advance(sprint, 6000).players.red.progress, 1.8);
  assert.equal(publicView(sprint).paceRules.visibleDistance, 60, "a stray sprint field cannot alter the legacy engine");
});

test("sprint doubles each speed mode but not lane changes, countdown, or the race deadline", () => {
  for (const [mode, speed] of [["slow", 2], ["normal", 3.6], ["turbo", 5]] as const) {
    const state = running("sprint-2x", mode);
    assert.equal(state.startedAt, 5000);
    assert.equal(publicView(state).players.red.speed, speed);
    near(advance(state, 6000).players.red.progress, speed);
  }
  const steering = applyInput(running("sprint-2x"), "red", { type: "lane", lane: 1 }, 5000);
  near(advance(steering, 5300).players.red.lane, 0.48);
  assert.equal(publicView(steering).players.red.laneVelocity, 1.6);
  const longRace = running("sprint-2x", "slow");
  longRace.course.length = 1000;
  const ended = advance(longRace, 1_000_000);
  assert.equal(ended.finishedAt, 185000);
  assert.equal(ended.finishReason, "time_limit");
  assert.equal(ended.players.red.progress, 360);
});

test("generated obstacles and forks are unchanged; a clean sprint completes twice as fast", () => {
  const layouts = new Set<string>();
  for (const seed of ["speed-test-0", "speed-test-1", "speed-test-2", "speed-test-3", "speed-test-4", "speed-test-5"]) {
    const classic = createRace(seed, 0), sprint = createRace(seed, 0, { pace: "sprint-2x" });
    assert.deepEqual(sprint.course, classic.course);
    layouts.add(sprint.course.layout!);
    const finish = (source: RaceState) => {
      source.course.obstacles = [];
      for (const id of IDS) {
        source = applyInput(source, id, { type: "join" }, 0);
        source = applyInput(source, id, { type: "ready" }, 0);
      }
      const ended = advance(source, 200000);
      sameOutcome(ended, polled(source, 200000));
      return ended.finishedAt! - ended.startedAt!;
    };
    const classicMs = finish(classic), sprintMs = finish(sprint);
    near(sprintMs * 2, classicMs);
    assert.ok(sprintMs > 56000 && sprintMs < 57000);
  }
  assert.equal(layouts.size, 3);
});

test("sprint sweeps exact obstacle and rival contact times while keeping four-second penalties", () => {
  const gate = running("sprint-2x");
  gate.course.obstacles = [{ id: "gate", progress: 18, blockedLane: 0 }];
  const hit = advance(gate, 10000);
  assert.equal(hit.players.red.collisionCount, 1);
  assert.equal(hit.players.red.slowedUntil, 14000);
  near(publicView(hit).players.red.speed, 1.44);
  near(advance(gate, 15000).players.red.progress, 18 + 4 * 1.44 + 3.6);
  sameOutcome(advance(gate, 35000), polled(gate, 35000));

  const rear = running("sprint-2x", "slow");
  rear.players.red.speedMode = "turbo";
  rear.players.red.lane = rear.players.red.targetLane = rear.players.blue.lane = rear.players.blue.targetLane = 1;
  rear.players.blue.progress = 8;
  const hitAt = 5000 + (8 - RACE_RULES.carLength) / 3 * 1000;
  const contact = advance(rear, hitAt + 1);
  for (const id of IDS) {
    assert.equal(contact.players[id].carCollisions, 1);
    near(contact.players[id].lastCarCollisionAt!, hitAt);
    near(contact.players[id].slowedUntil, hitAt + 4000);
  }
  const following = advance(rear, 20000);
  near(following.players.blue.progress - following.players.red.progress, 2.4);
  sameOutcome(following, polled(rear, 20000));
});

test("sprint keeps jump, landing cooldown and banana spin on real milliseconds", () => {
  const source = running("sprint-2x", "turbo");
  source.course.obstacles = [
    { id: "air-banana", progress: 2, blockedLane: 0, assetId: "banana_peel" },
    { id: "landing-banana", progress: 4, blockedLane: 0, assetId: "banana_peel" },
  ];
  const jumping = applyInput(source, "red", { type: "jump" }, 5000);
  assert.equal(jumping.players.red.jumpEndsAt, 5800);
  assert.equal(jumping.players.red.jumpReadyAt, 7800);
  const unchanged = JSON.stringify(jumping);
  assert.throws(() => applyInput(jumping, "red", { type: "jump" }, 5001), RaceRuleError);
  assert.equal(JSON.stringify(jumping), unchanged);
  assert.equal(advance(jumping, 5799).players.red.collisionCount, 0);
  const landed = advance(jumping, 5800);
  assert.equal(landed.players.red.spinStartedAt, 5800);
  assert.equal(landed.players.red.spinEndsAt, 7000);
  assert.equal(landed.players.red.spinProgress, 4);
  assert.equal(publicView(landed).players.red.speed, 0);
  assert.equal(advance(jumping, 6999).players.red.progress, 4);
  const after = advance(jumping, 8000);
  assert.equal(after.players.red.collisionCount, 1);
  assert.equal(after.history.filter(event => event.type === "obstacle_avoided").length, 1);
  assert.equal(after.history.filter(event => event.type === "spin_ended").length, 1);
  near(after.players.red.progress, 9);
  assert.equal(publicView(after).players.red.jumpAvailable, true);
  sameOutcome(after, polled(jumping, 8000));
});

test("sprint publishes a 120-unit horizon while classic readers retain 60 units", () => {
  for (const pace of [undefined, "sprint-2x"] as const) {
    const state = running(pace);
    state.course.obstacles = [60, 60.1, 120, 120.1].map(progress => ({ id: String(progress), progress, blockedLane: 1 }));
    const view = publicView(state);
    assert.deepEqual(view.players.red.upcomingObstacles.map(obstacle => obstacle.progress), pace ? [60, 60.1, 120] : [60]);
    assert.deepEqual(view.paceRules, pace ? { speedMultiplier: 2, visibleDistance: 120, placementAhead: 60 } : { speedMultiplier: 1, visibleDistance: 60, placementAhead: 12 });
    assert.equal(placementView({ raceId: "test", finalState: view })!.minProgress, pace ? 60 : 12);
    assert.equal(placementView({ raceId: "test", finalState: view })!.rules.ahead, pace ? 60 : 12);
  }
});

test("sprint placement requires 60 units from both current cars and preserves sorted gate cursors", () => {
  const state = running("sprint-2x", "turbo");
  state.course.obstacles = [{ id: "passed", progress: 10, blockedLane: 0 }, { id: "next", progress: 90, blockedLane: 0 }, { id: "later", progress: 140, blockedLane: 0 }];
  for (const id of IDS) { state.players[id].progress = 25; state.players[id].nextObstacleIndex = 1; }
  const before = JSON.stringify(state);
  assert.throws(() => placeObstacle(state, { assetId: "traffic_cone", lane: 0, progress: 84.99 }, 5000, "rejected"), /60以上/);
  assert.equal(JSON.stringify(state), before);
  const inserted = placeObstacle(state, { assetId: "traffic_cone", lane: 0, progress: 85 }, 5000, "inserted");
  assert.deepEqual(inserted.course.obstacles.map(obstacle => obstacle.id), ["passed", "inserted", "next", "later"]);
  assert.equal(inserted.players.red.nextObstacleIndex, 1);
  const ended = advance(inserted, 60000);
  assert.deepEqual(ended.history.filter(event => event.type === "collision").map(event => event.obstacleId), ["inserted", "next", "later"]);
  sameOutcome(ended, polled(inserted, 60000));
  assert.throws(() => placeObstacle(state, { assetId: "traffic_cone", lane: 1, progress: 85 }, 5100, "late"), /60以上/, "validation advances the live cars before checking the lead distance");
  const classic = running();
  assert.equal(placeObstacle(classic, { assetId: "traffic_cone", lane: 1, progress: 12 }, 5000, "classic").course.obstacles[0].progress, 12);
});

test("sprint preserves route lock positions, multipliers, and millisecond clock origin invariance", () => {
  const setup = (epoch: number) => {
    const state = running("sprint-2x", "turbo", epoch);
    state.course.junctions = [{ id: "fork", name: "test", start: 20, end: 50, defaultRoute: "right", routes: {
      left: { name: "fast", description: "fast", speedMultiplier: 1.18, blockedLanes: [] },
      right: { name: "wide", description: "wide", speedMultiplier: 0.94, blockedLanes: [] },
    } }];
    return applyInput(state, "red", { type: "route", junctionId: "fork", route: "left" }, epoch + 5000);
  };
  for (const epoch of [0, 1_800_000_000_000]) {
    const state = setup(epoch), entered = advance(state, epoch + 9000);
    near(entered.players.red.progress, 20);
    near(publicView(entered).players.red.speed, 5.9);
    assert.throws(() => applyInput(entered, "red", { type: "route", junctionId: "fork", route: "right" }, epoch + 9000), /locked/);
    const ended = advance(state, epoch + 120000);
    sameOutcome(ended, polled(state, epoch + 120000));
    // Adding a fractional millisecond to a Unix epoch rounds at about 0.00024 ms.
    near(ended.finishedAt! - epoch - 5000, (20 / 5 + 30 / 5.9 + 150 / 5) * 1000, 0.001);
  }
});
