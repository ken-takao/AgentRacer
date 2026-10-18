import assert from "node:assert/strict";
import test from "node:test";
import { advance, applyInput, createRace, publicView, raceCarInteraction, RACE_RULES, RaceRuleError } from "../lib/race-engine.ts";
import type { CarInteraction, RaceState } from "../lib/race-engine.ts";

const IDS = ["red", "blue"] as const;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.00001, `${a} != ${b}`);
function running(carInteraction?: CarInteraction, epoch = 0): RaceState {
  let state = createRace("ghost-race", epoch, { carInteraction });
  state.course.obstacles = [];
  state.course.junctions = [];
  for (const id of IDS) {
    state = applyInput(state, id, { type: "join" }, epoch);
    state = applyInput(state, id, { type: "ready" }, epoch);
  }
  return advance(state, epoch + RACE_RULES.countdownMs);
}
function polled(state: RaceState, end: number): RaceState {
  for (let at = state.updatedAt + 71; at < end; at += 71) state = advance(state, at);
  return advance(state, end);
}
function sameMotion(a: RaceState, b: RaceState): void {
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
function noCarImpact(state: RaceState): void {
  for (const id of IDS) assert.equal(state.players[id].carCollisions, 0);
  assert.equal(state.history.some(event => event.type === "car_collision"), false);
  assert.equal(state.carContact, undefined);
}

test("new races save ghost rules, old saved v2 races remain solid, and the pace stays classic", () => {
  const state = JSON.parse(JSON.stringify(createRace("new", 0))) as RaceState;
  assert.equal(state.carInteraction, "ghost");
  assert.equal(raceCarInteraction(state), "ghost");
  assert.equal(publicView(state).carInteraction, "ghost");
  assert.equal(publicView(state).paceRules.speedMultiplier, 1);
  const saved = running("solid");
  delete saved.carInteraction;
  assert.equal(raceCarInteraction(saved), "solid");
  assert.equal(publicView(saved).carInteraction, "solid");
  assert.equal(Object.hasOwn(saved, "carInteraction"), false, "reading must not migrate saved rules");
  for (const value of [null, true, "off", {}, ["ghost"]]) {
    assert.throws(() => createRace("invalid", 0, { carInteraction: value as CarInteraction }), RaceRuleError);
  }
  const legacy = { ...running(), version: 1 as const };
  assert.equal(raceCarInteraction(legacy), "solid", "the field cannot select new rules for v1");
});

test("ghosts overtake through the same lane; missing-field saved races retain rear-end blocking", () => {
  for (const epoch of [0, 1_800_000_000_000]) {
    const state = running(undefined, epoch);
    for (const id of IDS) state.players[id].lane = state.players[id].targetLane = 1;
    state.players.red.speedMode = "turbo";
    state.players.blue.speedMode = "slow";
    state.players.blue.progress = 8;
    const end = state.updatedAt + 15000;
    const ghost = advance(state, end);
    near(ghost.players.red.progress, 37.5);
    near(ghost.players.blue.progress, 23);
    assert.equal(ghost.players.red.slowedUntil, 0);
    noCarImpact(ghost);
    sameMotion(ghost, polled(state, end));
    const saved = structuredClone(state);
    delete saved.carInteraction;
    const solid = advance(saved, end);
    assert.equal(solid.players.red.carCollisions, 1);
    near(solid.players.blue.progress - solid.players.red.progress, RACE_RULES.carLength);
    assert.ok(solid.players.red.slowedUntil > state.updatedAt);
  }
});

test("simultaneous lane crossing and initial overlap do not push, stop, or slow ghosts", () => {
  let state = running();
  state.players.red.progress = state.players.blue.progress = 10;
  state = applyInput(state, "red", { type: "lane", lane: 2 }, state.updatedAt);
  state = applyInput(state, "blue", { type: "lane", lane: 0 }, state.updatedAt);
  const crossed = advance(state, state.updatedAt + 2000);
  near(crossed.players.red.lane, 2); near(crossed.players.blue.lane, 0);
  near(crossed.players.red.progress, 13.6); near(crossed.players.blue.progress, 13.6);
  noCarImpact(crossed);
  sameMotion(crossed, polled(state, state.updatedAt + 2000));
  const overlap = running();
  overlap.players.blue.lane = overlap.players.blue.targetLane = 0;
  // A stale internal latch cannot restore blocking in a ghost race.
  overlap.carContact = { axis: "progress", direction: 1 };
  overlap.players.red.speedMode = "turbo";
  assert.equal(publicView(overlap).players.red.speed, 2.5);
  const moved = advance(overlap, overlap.updatedAt + 1000);
  near(moved.players.red.progress, 2.5); near(moved.players.blue.progress, 1.8);
  near(moved.players.red.lane, 0); near(moved.players.blue.lane, 0);
  noCarImpact(moved);
});

test("both branch exits merge freely while route locking and route-specific obstacles stay active", () => {
  for (const start of [20, 100]) {
    const state = running();
    state.course.junctions = [{ id: "fork", name: "TEST", start, end: start + 20, defaultRoute: "left", routes: {
      left: { name: "L", description: "", speedMultiplier: 1, blockedLanes: [0] },
      right: { name: "R", description: "", speedMultiplier: 1, blockedLanes: [] },
    } }];
    for (const id of IDS) {
      state.players[id].progress = start + 19;
      state.players[id].lane = state.players[id].targetLane = 0;
      state.players[id].routeChoices = { fork: id === "red" ? "left" : "right" };
    }
    assert.throws(() => applyInput(state, "red", { type: "route", junctionId: "fork", route: "right" }, state.updatedAt), RaceRuleError);
    const merged = advance(state, state.updatedAt + 2000);
    near(merged.players.red.progress, start + 22.6);
    near(merged.players.blue.progress, start + 22.6);
    noCarImpact(merged);
    sameMotion(merged, polled(state, state.updatedAt + 2000));
    state.course.obstacles = [{ id: "left-only", junctionId: "fork", route: "left", blockedLane: 0, progress: start + 19.5 }];
    const hit = advance(state, state.updatedAt + 1000);
    assert.equal(hit.players.red.collisionCount, 1);
    assert.equal(hit.players.blue.collisionCount, 0);
    noCarImpact(hit);
  }
});

test("shared obstacles still hit each ghost independently, with the original penalty and exact cursor", () => {
  const state = running();
  state.players.blue.lane = state.players.blue.targetLane = 0;
  state.course.obstacles = [{ id: "cone", progress: 1.8, blockedLane: 0, assetId: "traffic_cone" }];
  const hit = advance(state, 6500);
  for (const id of IDS) {
    assert.equal(hit.players[id].collisionCount, 1);
    assert.equal(hit.players[id].slowedUntil, 10000);
    near(hit.players[id].progress, 2.16);
    assert.equal(hit.players[id].nextObstacleIndex, 1);
  }
  noCarImpact(hit);
  const later = advance(state, 11000);
  sameMotion(later, polled(state, 11000));
  assert.equal(later.history.filter(event => event.type === "collision").length, 2);
});

test("jumping ghost avoids banana while the overlapping opponent spins for 1.2 seconds", () => {
  let state = running();
  for (const id of IDS) {
    state.players[id].lane = state.players[id].targetLane = 0;
    state.players[id].speedMode = "turbo";
  }
  state.course.obstacles = [{ id: "banana", progress: 1.25, blockedLane: 0, assetId: "banana_peel" }];
  state = applyInput(state, "red", { type: "jump" }, 5000);
  state = advance(state, 5600);
  assert.equal(state.players.red.collisionCount, 0);
  assert.equal(state.players.red.jumpEndsAt, 5800);
  assert.equal(state.players.red.jumpReadyAt, 7800);
  assert.equal(state.players.blue.spinStartedAt, 5500);
  assert.equal(state.players.blue.spinEndsAt, 6700);
  state = applyInput(state, "blue", { type: "lane", lane: 2 }, 5600);
  state = applyInput(state, "blue", { type: "speed", speed: "normal" }, 5600);
  const stopped = advance(state, 6600);
  near(stopped.players.blue.progress, 1.25); near(stopped.players.blue.lane, 0);
  const resumed = advance(state, 6800);
  near(resumed.players.blue.progress, 1.43); near(resumed.players.blue.lane, 0.16);
  noCarImpact(resumed);
  assert.equal(resumed.players.blue.collisionCount, 1);
  assert.equal(resumed.history.filter(event => event.type === "spin_started").length, 1);
  assert.equal(resumed.history.filter(event => event.type === "spin_ended").length, 1);
  sameMotion(resumed, polled(state, 6800));
});
