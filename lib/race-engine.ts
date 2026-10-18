import { activeJunction, createCourseFeatures, roadKey, routeSpeedMultiplier, selectedRoute } from "./race-course.ts";
import type { CourseFeatures, RouteChoice } from "./race-course.ts";
import { getObstacleAsset } from "./obstacle-catalog.ts";

/** Deterministic, wall-clock racing. Times are Unix milliseconds; distance is in track units. */
export type PlayerId = "red" | "blue";
export type Lane = 0 | 1 | 2;
export type SpeedMode = "slow" | "normal" | "turbo";
export type RacePace = "sprint-2x";
export type CarInteraction = "solid" | "ghost";
export type RacePhase = "lobby" | "countdown" | "racing" | "finished" | "cancelled";
export type RaceInput =
  | { type: "join" }
  | { type: "ready" }
  | { type: "lane"; lane: Lane }
  | { type: "speed"; speed: SpeedMode }
  | { type: "jump" }
  | { type: "route"; junctionId: string; route: RouteChoice };

export const RACE_RULES = {
  length: 200,
  countdownMs: 5_000,
  maxRaceMs: 180_000,
  visibleDistance: 60,
  laneChangePerSecond: 1.6,
  collisionSlowMs: 4_000,
  collisionSpeedMultiplier: 0.4,
  collisionHalfWidth: 0.45,
  carLength: 2.4,
  carWidth: 0.7,
  jumpMs: 800,
  jumpCooldownMs: 2_000,
  spinMs: 1_200,
  placementAhead: 12,
  placementSpacing: 4,
  placementFinishMargin: 3,
  placementMax: 20,
  placementCooldownMs: 1_500,
  speeds: { slow: 1, normal: 1.8, turbo: 2.5 },
} as const;

const CLASSIC_PACE_RULES = Object.freeze({ speedMultiplier: 1, visibleDistance: RACE_RULES.visibleDistance, placementAhead: RACE_RULES.placementAhead });
const SPRINT_PACE_RULES = Object.freeze({ speedMultiplier: 2, visibleDistance: 120, placementAhead: 60 });
export type RacePaceRules = Readonly<{ speedMultiplier: number; visibleDistance: number; placementAhead: number }>;

/** A saved opt-in selects a stable ruleset; missing fields and all v1 races stay classic. */
export function racePaceRules(state: Pick<RaceState, "version" | "pace">): RacePaceRules {
  return state.version === 2 && state.pace === "sprint-2x" ? SPRINT_PACE_RULES : CLASSIC_PACE_RULES;
}

/** Missing fields preserve the contact rules of already saved races. */
export function raceCarInteraction(state: Pick<RaceState, "version" | "carInteraction">): CarInteraction {
  return state.version === 2 && state.carInteraction === "ghost" ? "ghost" : "solid";
}

export interface Obstacle {
  id: string;
  progress: number;
  blockedLane: Lane;
  junctionId?: string;
  route?: RouteChoice;
  assetId?: string;
  placedAt?: number;
}

export interface ObstaclePlacement {
  assetId: string;
  lane: Lane;
  progress: number;
  route?: RouteChoice;
}

export interface Racer {
  id: PlayerId;
  name: string;
  joined: boolean;
  ready: boolean;
  progress: number;
  /** Lane position interpolates continuously toward targetLane. */
  lane: number;
  targetLane: Lane;
  speedMode: SpeedMode;
  collisionCount: number;
  slowedUntil: number;
  /** Engine cursor: a gate is crossed exactly once, even on sparse polling. */
  nextObstacleIndex: number;
  routeChoices?: Record<string, RouteChoice>;
  carCollisions?: number;
  lastCarCollisionAt?: number;
  jumpStartedAt?: number;
  jumpEndsAt?: number;
  jumpReadyAt?: number;
  spinStartedAt?: number;
  spinEndsAt?: number;
  spinProgress?: number;
  spinLane?: number;
}

export interface RaceEvent {
  at: number;
  type: "joined" | "ready" | "countdown" | "race_started" | "lane_change" | "speed_change" | "route_change" | "route_entered" | "car_collision" | "collision" | "finished" | "jump_started" | "jump_landed" | "spin_started" | "spin_ended" | "obstacle_avoided" | "obstacle_placed";
  playerId?: PlayerId;
  obstacleId?: string;
  lane?: Lane;
  speedMode?: SpeedMode;
  junctionId?: string;
  route?: RouteChoice;
  assetId?: string;
  progress?: number;
}

interface CarContact { axis: "progress" | "lane"; direction: number }

export interface RaceState {
  version: 1 | 2;
  /** Immutable at creation; never inferred from a deployment's current defaults. */
  pace?: RacePace;
  /** Fixed when created; old saved races without this field keep their rules. */
  carInteraction?: CarInteraction;
  seed: string;
  phase: RacePhase;
  createdAt: number;
  updatedAt: number;
  countdownEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  finishReason: "finish_line" | "time_limit" | "cancelled" | null;
  winner: PlayerId | "tie" | null;
  players: Record<PlayerId, Racer>;
  course: { length: number; obstacles: Obstacle[] } & CourseFeatures;
  history: RaceEvent[];
  /** Private contact latch: one impact per continuous contact, independent of polls. */
  carContact?: CarContact;
  lastObstaclePlacedAt?: number;
  placedObstacleCount?: number;
}

export type PublicRacer = Omit<Racer, "nextObstacleIndex"> & {
  speed: number;
  laneVelocity: number;
  upcomingObstacles: Obstacle[];
  jumpAvailable: boolean;
  jumpCooldownRemainingMs: number;
  spinRemainingMs: number;
};
export type PublicRaceState = Omit<RaceState, "players" | "carContact"> & {
  players: Record<PlayerId, PublicRacer>;
  remainingMs: number;
  paceRules: RacePaceRules;
  carInteraction: CarInteraction;
};

export class RaceRuleError extends Error {
  readonly code: "INVALID_INPUT" | "PLAYER_NOT_JOINED" | "RACE_NOT_AVAILABLE" | "RACE_FINISHED";
  constructor(code: "INVALID_INPUT" | "PLAYER_NOT_JOINED" | "RACE_NOT_AVAILABLE" | "RACE_FINISHED", message: string) {
    super(message);
    this.code = code;
    this.name = "RaceRuleError";
  }
}

const IDS: PlayerId[] = ["red", "blue"];
const EPSILON = 1e-7;

function validTime(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new RaceRuleError("INVALID_INPUT", "now must be a non-negative, finite timestamp in milliseconds");
}

function rngFor(seed: string): () => number {
  let word = 2166136261;
  for (let i = 0; i < seed.length; i++) word = Math.imul(word ^ seed.charCodeAt(i), 16777619);
  return () => {
    word = (word + 0x6d2b79f5) | 0;
    let n = Math.imul(word ^ (word >>> 15), 1 | word);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function copy(state: RaceState): RaceState {
  return {
    ...state,
    players: Object.fromEntries(IDS.map(id => [id, { ...state.players[id], ...(state.players[id].routeChoices ? { routeChoices: { ...state.players[id].routeChoices } } : {}) }])) as Record<PlayerId, Racer>,
    course: { ...state.course, obstacles: state.course.obstacles.map((obstacle) => ({ ...obstacle })), ...(state.course.junctions ? { junctions: state.course.junctions.map(j => ({ ...j, routes: { left: { ...j.routes.left, blockedLanes: [...j.routes.left.blockedLanes] }, right: { ...j.routes.right, blockedLanes: [...j.routes.right.blockedLanes] } } })) } : {}) },
    ...(state.carContact ? { carContact: { ...state.carContact } } : {}),
    history: state.history.map((event) => ({ ...event })),
  };
}

function log(state: RaceState, event: RaceEvent): void {
  state.history.push(event);
  // Bound serialized storage even when an agent repeatedly changes its controls.
  if (state.history.length > 160) state.history.splice(0, state.history.length - 160);
}

function movingSpeed(player: Racer, at: number, origin = 0): number {
  return RACE_RULES.speeds[player.speedMode] * (at < player.slowedUntil - origin - EPSILON ? RACE_RULES.collisionSpeedMultiplier : 1);
}

function isAirborne(player: Pick<Racer, "jumpStartedAt" | "jumpEndsAt">, at: number, origin = 0): boolean {
  return player.jumpStartedAt !== undefined && at >= player.jumpStartedAt - origin - EPSILON && at < (player.jumpEndsAt ?? 0) - origin - EPSILON;
}

function isSpinning(player: Pick<Racer, "spinStartedAt" | "spinEndsAt">, at: number, origin = 0): boolean {
  return player.spinStartedAt !== undefined && at >= player.spinStartedAt - origin - EPSILON && at < (player.spinEndsAt ?? 0) - origin - EPSILON;
}

/** A stopped car cannot have a future arrival; avoid 0 / 0 at a gate. */
function arrivalTime(cursor: number, distance: number, speed: number): number {
  return distance <= EPSILON ? cursor : speed > EPSILON ? cursor + distance / speed * 1000 : Infinity;
}

export function createRace(seed: string | number, now: number, options: { pace?: RacePace; carInteraction?: CarInteraction } = {}): RaceState {
  validTime(now);
  if (!options || typeof options !== "object" || Array.isArray(options) || (options.pace !== undefined && options.pace !== "sprint-2x")) {
    throw new RaceRuleError("INVALID_INPUT", "Unknown race pace");
  }
  if (options.carInteraction !== undefined && options.carInteraction !== "ghost" && options.carInteraction !== "solid") {
    throw new RaceRuleError("INVALID_INPUT", "Unknown car interaction");
  }
  if ((typeof seed !== "string" && typeof seed !== "number") || (typeof seed === "number" && !Number.isFinite(seed))) {
    throw new RaceRuleError("INVALID_INPUT", "seed must be a string or finite number");
  }
  const seedText = String(seed);
  const random = rngFor(seedText);
  const features = createCourseFeatures(seedText, RACE_RULES.length);
  let previousLane: Lane | undefined;
  const obstacles: Obstacle[] = [25, 50, 75, 100, 125, 150, 175].filter(progress => !activeJunction(features, progress)).map((progress, index) => {
    let lane = Math.floor(random() * 3) as Lane;
    if (lane === previousLane) lane = ((lane + 1 + Math.floor(random() * 2)) % 3) as Lane;
    previousLane = lane;
    return { id: `gate-${index + 1}`, progress, blockedLane: lane };
  });
  for (const junction of features.junctions) {
    for (const route of ["left", "right"] as const) {
      junction.routes[route].blockedLanes.forEach((blockedLane, index, lanes) => obstacles.push({
        id: `${junction.id}-${route}-${index + 1}`, junctionId: junction.id, route,
        progress: junction.start + (junction.end - junction.start) * (index + 1) / (lanes.length + 1), blockedLane,
      }));
    }
  }
  obstacles.sort((a, b) => a.progress - b.progress);
  const player = (id: PlayerId, lane: Lane): Racer => ({
    id, name: id === "red" ? "RED" : "BLUE", joined: false, ready: false,
    progress: 0, lane, targetLane: lane, speedMode: "normal", collisionCount: 0,
    slowedUntil: 0, nextObstacleIndex: 0, routeChoices: {}, carCollisions: 0,
  });
  return {
    version: 2, ...(options.pace ? { pace: options.pace } : {}), carInteraction: options.carInteraction ?? "ghost", seed: seedText, phase: "lobby", createdAt: now, updatedAt: now,
    countdownEndsAt: null, startedAt: null, finishedAt: null, finishReason: null, winner: null,
    players: { red: player("red", 0), blue: player("blue", 2) },
    course: { length: RACE_RULES.length, obstacles, ...features }, history: [],
  };
}

function finish(state: RaceState, at: number, reason: "finish_line" | "time_limit"): void {
  const red = state.players.red.progress;
  const blue = state.players.blue.progress;
  state.phase = "finished";
  state.finishedAt = at;
  state.finishReason = reason;
  state.winner = Math.abs(red - blue) < EPSILON ? "tie" : red > blue ? "red" : "blue";
  log(state, { at, type: "finished" });
}

/**
 * Advance by real elapsed time, regardless of agent activity or polling frequency.
 * Event boundaries (gate, slowdown expiry, finish, deadline) are solved exactly.
 * The first finisher stops the race, so delayed polling cannot change the winner.
 */
function advanceLegacy(source: RaceState, now: number): RaceState {
  validTime(now);
  const state = copy(source);
  const targetTime = Math.max(now, state.updatedAt);
  let cursor = state.updatedAt;
  if (state.phase === "countdown" && state.countdownEndsAt !== null && targetTime >= state.countdownEndsAt) {
    cursor = state.countdownEndsAt;
    state.phase = "racing";
    state.startedAt = cursor;
    log(state, { at: cursor, type: "race_started" });
  }

  if (state.phase === "racing" && state.startedAt !== null) {
    const origin = state.startedAt;
    const deadline = origin + RACE_RULES.maxRaceMs;
    // Integrate on a small, race-relative clock. At Unix-millisecond magnitude,
    // rounding a gate time can leave the car just short of it and make the next
    // event round back to the same timestamp forever.
    cursor -= origin;
    const until = Math.min(targetTime - origin, RACE_RULES.maxRaceMs);
    while (cursor < until - EPSILON && state.phase === "racing") {
      let nextTime = until;
      const speeds = { red: movingSpeed(state.players.red, cursor, origin), blue: movingSpeed(state.players.blue, cursor, origin) };
      const gateTimes: Partial<Record<PlayerId, number>> = {};
      const finishTimes = { red: Infinity, blue: Infinity };
      for (const id of IDS) {
        const player = state.players[id];
        const slowdownEndsAt = player.slowedUntil - origin;
        if (slowdownEndsAt > cursor + EPSILON) nextTime = Math.min(nextTime, slowdownEndsAt);
        const nextGate = state.course.obstacles[player.nextObstacleIndex];
        if (nextGate) {
          gateTimes[id] = cursor + Math.max(0, nextGate.progress - player.progress) / speeds[id] * 1000;
          nextTime = Math.min(nextTime, gateTimes[id]);
        }
        finishTimes[id] = cursor + Math.max(0, state.course.length - player.progress) / speeds[id] * 1000;
        nextTime = Math.min(nextTime, finishTimes[id]);
      }

      const seconds = (nextTime - cursor) / 1000;
      for (const id of IDS) {
        const player = state.players[id];
        player.progress = Math.min(state.course.length, player.progress + speeds[id] * seconds);
        // A selected event is reached by construction; settle its exact distance
        // instead of relying on the rounded multiply/divide to reproduce it.
        if (gateTimes[id] === nextTime) player.progress = Math.max(player.progress, state.course.obstacles[player.nextObstacleIndex].progress);
        if (finishTimes[id] === nextTime) player.progress = state.course.length;
        const difference = player.targetLane - player.lane;
        player.lane += Math.sign(difference) * Math.min(Math.abs(difference), RACE_RULES.laneChangePerSecond * seconds);
      }
      cursor = nextTime;

      // Both cars cross their gates before checking the winner: no player-order advantage.
      for (const id of IDS) {
        const player = state.players[id];
        const gate = state.course.obstacles[player.nextObstacleIndex];
        if (gate && player.progress >= gate.progress - EPSILON) {
          player.nextObstacleIndex++;
          if (Math.abs(player.lane - gate.blockedLane) <= RACE_RULES.collisionHalfWidth + EPSILON) {
            player.collisionCount++;
            player.slowedUntil = origin + cursor + RACE_RULES.collisionSlowMs;
            log(state, { at: origin + cursor, type: "collision", playerId: id, obstacleId: gate.id });
          }
        }
      }
      if (IDS.some((id) => state.players[id].progress >= state.course.length - EPSILON)) finish(state, origin + cursor, "finish_line");
    }
    if (state.phase === "racing" && targetTime >= deadline) finish(state, deadline, "time_limit");
  }
  state.updatedAt = targetTime;
  return state;
}

function appliesToRoute(state: RaceState, player: Racer, obstacle: Obstacle): boolean {
  if (!obstacle.junctionId || !obstacle.route) return true;
  const junction = state.course.junctions?.find(j => j.id === obstacle.junctionId);
  return !!junction && selectedRoute(junction, player) === obstacle.route;
}

function nextGate(state: RaceState, player: Racer): { gate: Obstacle; index: number } | undefined {
  for (let index = player.nextObstacleIndex; index < state.course.obstacles.length; index++) {
    const gate = state.course.obstacles[index];
    if (appliesToRoute(state, player, gate)) return { gate, index };
  }
}

/** At an exit the leading car already occupies the merge, even before the follower exits. */
function shareRoad(state: RaceState): boolean {
  const { red, blue } = state.players;
  if (roadKey(state.course, red) === roadKey(state.course, blue)) return true;
  const redFork = activeJunction(state.course, red.progress);
  const blueFork = activeJunction(state.course, blue.progress);
  if (redFork && blueFork) return false;
  const fork = redFork ?? blueFork;
  const outside = redFork ? blue : red;
  return !!fork && (outside.progress >= fork.end || outside.progress < fork.start);
}

type Motion = { speed: Record<PlayerId, number>; lane: Record<PlayerId, number> };

function motionAt(state: RaceState, at: number, origin = 0): Motion {
  const speed = { red: 0, blue: 0 };
  const lane = { red: 0, blue: 0 };
  for (const id of IDS) {
    const player = state.players[id];
    if (!isSpinning(player, at, origin)) {
      speed[id] = movingSpeed(player, at, origin) * racePaceRules(state).speedMultiplier * routeSpeedMultiplier(state.course, player);
      lane[id] = Math.abs(player.targetLane - player.lane) > EPSILON ? Math.sign(player.targetLane - player.lane) * RACE_RULES.laneChangePerSecond : 0;
    }
  }
  if (raceCarInteraction(state) === "solid" && state.carContact && shareRoad(state)) {
    const { axis, direction } = state.carContact;
    const x = state.players.blue.progress - state.players.red.progress;
    const y = state.players.blue.lane - state.players.red.lane;
    const leavingSide = Math.abs(y) >= RACE_RULES.carWidth - EPSILON && y * (lane.blue - lane.red) > EPSILON;
    const leavingEnd = Math.abs(x) >= RACE_RULES.carLength - EPSILON && x * (speed.blue - speed.red) > EPSILON;
    if (axis === "progress" && !leavingSide && (speed.blue - speed.red) * direction < 0) {
      // The trailing car cannot drive through the leading car; it may steer out.
      if (direction > 0) speed.red = speed.blue;
      else speed.blue = speed.red;
    }
    if (axis === "lane" && !leavingEnd && (lane.blue - lane.red) * direction < 0) {
      // Maintain the lateral gap. Cars moving together may move as a pair;
      // opposite inward commands stop until one steers away or drives clear.
      const together = lane.red * lane.blue > 0 ? Math.sign(lane.red) * Math.min(Math.abs(lane.red), Math.abs(lane.blue)) : 0;
      lane.red = lane.blue = together;
    }
  }
  return { speed, lane };
}

function contactEnded(state: RaceState): boolean {
  if (raceCarInteraction(state) === "ghost") return true;
  if (!shareRoad(state)) return true;
  const x = state.players.blue.progress - state.players.red.progress;
  const y = state.players.blue.lane - state.players.red.lane;
  return Math.abs(x) > RACE_RULES.carLength + EPSILON || Math.abs(y) > RACE_RULES.carWidth + EPSILON;
}

type ContactEvent = CarContact & { seconds: number };

/** Swept AABB intersection: no sampling, including cars swapping lanes between polls. */
function collisionTime(state: RaceState, motion: Motion): ContactEvent | undefined {
  if (raceCarInteraction(state) === "ghost" || !shareRoad(state) || state.carContact) return;
  const x = state.players.blue.progress - state.players.red.progress;
  const y = state.players.blue.lane - state.players.red.lane;
  const interval = (distance: number, velocity: number, extent: number): [number, number] => {
    if (Math.abs(velocity) < EPSILON) return Math.abs(distance) <= extent + EPSILON ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const a = (-extent - distance) / velocity;
    const b = (extent - distance) / velocity;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const vx = motion.speed.blue - motion.speed.red;
  const vy = motion.lane.blue - motion.lane.red;
  const [enterX, leaveX] = interval(x, vx, RACE_RULES.carLength);
  const [enterY, leaveY] = interval(y, vy, RACE_RULES.carWidth);
  const seconds = Math.max(0, enterX, enterY);
  const leave = Math.min(leaveX, leaveY);
  // A separating contact or an instantaneous corner graze is not a new impact.
  if (!Number.isFinite(seconds) || leave <= seconds + EPSILON) return;
  const penetrating = Math.abs(x) < RACE_RULES.carLength - EPSILON && Math.abs(y) < RACE_RULES.carWidth - EPSILON;
  if (seconds === 0 && !penetrating && Math.abs(vx) < EPSILON && Math.abs(vy) < EPSILON) return;
  // A newly shared merge may already overlap in race coordinates. Separate
  // those cars sideways instead of rewinding either car's completed distance.
  const axis = penetrating ? "lane" : enterX > enterY ? "progress" : "lane";
  const distance = axis === "progress" ? x + vx * seconds : y + vy * seconds;
  return { seconds, axis, direction: Math.sign(distance) || 1 };
}

function registerCarContact(state: RaceState, contact: ContactEvent, at: number): void {
  if (contact.axis === "progress" && Math.max(state.players.red.progress, state.players.blue.progress) < RACE_RULES.carLength) {
    // Grid overlap must not push a car to negative track distance.
    contact = { ...contact, axis: "lane", direction: Math.sign(state.players.blue.lane - state.players.red.lane) || 1 };
  }
  state.carContact = { axis: contact.axis, direction: contact.direction };
  const { red, blue } = state.players;
  if (contact.axis === "progress") {
    // Settle the swept bumper boundary exactly, including floating-point drift.
    const front = contact.direction > 0 ? blue : red;
    const rear = contact.direction > 0 ? red : blue;
    rear.progress = Math.min(rear.progress, front.progress - RACE_RULES.carLength);
  } else {
    const redSpinning = isSpinning(red, at);
    const blueSpinning = isSpinning(blue, at);
    if (redSpinning || blueSpinning) {
      // A banana's impact position is an anchor, including when another car hits it.
      const fixed = redSpinning ? red : blue;
      const other = redSpinning ? blue : red;
      if (!(redSpinning && blueSpinning)) {
        let direction = Math.sign(other.lane - fixed.lane) || (redSpinning ? contact.direction : -contact.direction);
        if (fixed.lane + direction * RACE_RULES.carWidth < 0 || fixed.lane + direction * RACE_RULES.carWidth > 2) direction *= -1;
        other.lane = fixed.lane + direction * RACE_RULES.carWidth;
        state.carContact.direction = Math.sign(blue.lane - red.lane) || 1;
      }
    } else {
      const middle = Math.max(RACE_RULES.carWidth / 2, Math.min(2 - RACE_RULES.carWidth / 2, (red.lane + blue.lane) / 2));
      red.lane = middle - contact.direction * RACE_RULES.carWidth / 2;
      blue.lane = middle + contact.direction * RACE_RULES.carWidth / 2;
    }
  }
  for (const id of IDS) {
    const player = state.players[id];
    player.carCollisions = (player.carCollisions ?? 0) + 1;
    player.collisionCount++;
    player.lastCarCollisionAt = at;
    player.slowedUntil = Math.max(player.slowedUntil, at + RACE_RULES.collisionSlowMs);
  }
  log(state, { at, type: "car_collision" });
}

function settleContact(state: RaceState, cursor: number, origin: number): void {
  if (state.carContact && contactEnded(state)) delete state.carContact;
  const contact = collisionTime(state, motionAt(state, cursor, origin));
  if (contact && contact.seconds <= EPSILON) registerCarContact(state, contact, origin + cursor);
}

function advanceInteractive(source: RaceState, now: number): RaceState {
  validTime(now);
  const state = copy(source);
  const targetTime = Math.max(now, state.updatedAt);
  let cursor = state.updatedAt;
  if (state.phase === "countdown" && state.countdownEndsAt !== null && targetTime >= state.countdownEndsAt) {
    cursor = state.countdownEndsAt;
    state.phase = "racing";
    state.startedAt = cursor;
    log(state, { at: cursor, type: "race_started" });
  }
  if (state.phase === "racing" && state.startedAt !== null) {
    const origin = state.startedAt;
    cursor -= origin;
    const until = Math.min(targetTime - origin, RACE_RULES.maxRaceMs);
    let eventCount = 0;
    while (cursor < until - EPSILON && state.phase === "racing") {
      // Valid courses have fewer than 100 boundaries. This bounds bad restored
      // state without allowing a numerical loop to exhaust the worker CPU.
      if (++eventCount > 2048) throw new RaceRuleError("RACE_NOT_AVAILABLE", "The race simulation could not advance");
      if (state.carContact && contactEnded(state)) delete state.carContact;
      const motion = motionAt(state, cursor, origin);
      const contact = collisionTime(state, motion);
      if (contact && contact.seconds <= EPSILON) {
        registerCarContact(state, contact, origin + cursor);
        continue;
      }
      let nextTime = until;
      const previousCursor = cursor;
      const contactAt = contact ? cursor + contact.seconds * 1000 : Infinity;
      nextTime = Math.min(nextTime, contactAt);
      const gates: Partial<Record<PlayerId, { gate: Obstacle; index: number; at: number }>> = {};
      const finishes = { red: Infinity, blue: Infinity };
      const laneEnds = { red: Infinity, blue: Infinity };
      const routeBounds: Partial<Record<PlayerId, { progress: number; at: number }>> = {};
      for (const id of IDS) {
        const player = state.players[id];
        const slowdownEnd = player.slowedUntil - origin;
        if (slowdownEnd > cursor + EPSILON) nextTime = Math.min(nextTime, slowdownEnd);
        for (const end of [player.jumpEndsAt, player.spinEndsAt]) {
          if (end !== undefined && end - origin > cursor + EPSILON) nextTime = Math.min(nextTime, end - origin);
        }
        if (motion.lane[id] !== 0) {
          laneEnds[id] = cursor + Math.abs((player.targetLane - player.lane) / motion.lane[id]) * 1000;
          nextTime = Math.min(nextTime, laneEnds[id]);
        }
        const next = nextGate(state, player);
        if (next) {
          gates[id] = { ...next, at: arrivalTime(cursor, next.gate.progress - player.progress, motion.speed[id]) };
          nextTime = Math.min(nextTime, gates[id].at);
        }
        finishes[id] = arrivalTime(cursor, state.course.length - player.progress, motion.speed[id]);
        nextTime = Math.min(nextTime, finishes[id]);
        const boundary = state.course.junctions?.flatMap(j => [j.start, j.end]).find(progress => progress > player.progress + EPSILON);
        if (boundary !== undefined) {
          routeBounds[id] = { progress: boundary, at: arrivalTime(cursor, boundary - player.progress, motion.speed[id]) };
          nextTime = Math.min(nextTime, routeBounds[id].at);
        }
      }
      if (state.carContact) {
        for (const [distance, velocity, extent] of [
          [state.players.blue.progress - state.players.red.progress, motion.speed.blue - motion.speed.red, RACE_RULES.carLength],
          [state.players.blue.lane - state.players.red.lane, motion.lane.blue - motion.lane.red, RACE_RULES.carWidth],
        ]) {
          if (Math.abs(velocity) > EPSILON) {
            const seconds = (Math.sign(velocity) * extent - distance) / velocity;
            if (seconds > EPSILON) nextTime = Math.min(nextTime, cursor + seconds * 1000);
          }
        }
      }
      const seconds = Math.max(0, nextTime - cursor) / 1000;
      for (const id of IDS) {
        const player = state.players[id];
        player.progress = Math.min(state.course.length, player.progress + motion.speed[id] * seconds);
        player.lane = Math.max(0, Math.min(2, player.lane + motion.lane[id] * seconds));
        if (gates[id]?.at === nextTime) player.progress = Math.max(player.progress, gates[id].gate.progress);
        if (finishes[id] === nextTime) player.progress = state.course.length;
        if (laneEnds[id] === nextTime) player.lane = player.targetLane;
        if (routeBounds[id]?.at === nextTime) player.progress = Math.max(player.progress, routeBounds[id].progress);
      }
      cursor = nextTime;
      for (const id of IDS) {
        const player = state.players[id];
        for (const [end, type] of [[player.jumpEndsAt, "jump_landed"], [player.spinEndsAt, "spin_ended"]] as const) {
          if (end !== undefined && end - origin > previousCursor + EPSILON && end - origin <= cursor + EPSILON) {
            log(state, { at: end, type, playerId: id });
          }
        }
        const entry = state.course.junctions?.find(j => Math.abs(j.start - player.progress) <= EPSILON);
        if (entry) {
          player.routeChoices ??= {};
          player.routeChoices[entry.id] = selectedRoute(entry, player);
          log(state, { at: origin + cursor, type: "route_entered", playerId: id, junctionId: entry.id, route: player.routeChoices[entry.id] });
        }
        const crossed = gates[id];
        if (crossed && player.progress >= crossed.gate.progress - EPSILON) {
          player.nextObstacleIndex = crossed.index + 1;
          if (Math.abs(player.lane - crossed.gate.blockedLane) <= RACE_RULES.collisionHalfWidth + EPSILON) {
            const at = origin + cursor;
            if (isAirborne(player, cursor, origin)) {
              log(state, { at, type: "obstacle_avoided", playerId: id, obstacleId: crossed.gate.id });
            } else {
              player.collisionCount++;
              log(state, { at, type: "collision", playerId: id, obstacleId: crossed.gate.id });
              if (crossed.gate.assetId === "banana_peel") {
                player.spinStartedAt = at;
                player.spinEndsAt = at + RACE_RULES.spinMs;
                player.spinProgress = player.progress;
                player.spinLane = player.lane;
                log(state, { at, type: "spin_started", playerId: id, obstacleId: crossed.gate.id });
              } else {
                player.slowedUntil = Math.max(player.slowedUntil, at + RACE_RULES.collisionSlowMs);
              }
            }
          }
        }
      }
      if (contact && contactAt === nextTime && shareRoad(state)) registerCarContact(state, contact, origin + cursor);
      settleContact(state, cursor, origin);
      if (IDS.some(id => state.players[id].progress >= state.course.length - EPSILON)) finish(state, origin + cursor, "finish_line");
    }
    if (state.phase === "racing") settleContact(state, cursor, origin);
    if (state.phase === "racing" && targetTime - origin >= RACE_RULES.maxRaceMs) finish(state, origin + RACE_RULES.maxRaceMs, "time_limit");
  }
  state.updatedAt = targetTime;
  return state;
}

/** Saved v1 races retain their rules; new races use continuous car contacts and forks. */
export function advance(source: RaceState, now: number): RaceState {
  return source.version === 2 ? advanceInteractive(source, now) : advanceLegacy(source, now);
}

/** Stop at the current wall-clock position; repeated cancellation is idempotent. */
export function cancelRace(source: RaceState, now: number): RaceState {
  const state = advance(source, now);
  // A stop arriving after the finish must preserve the actual race result.
  if (state.phase === "finished" || state.phase === "cancelled") return state;
  state.phase = "cancelled";
  state.finishedAt = state.updatedAt;
  state.finishReason = "cancelled";
  state.winner = null;
  return state;
}

/** Validate inside the same storage CAS as driving; no rejected operation is persisted. */
export function placeObstacle(source: RaceState, input: ObstaclePlacement, now: number, obstacleId: string): RaceState {
  if (!input || typeof input !== "object" || !getObstacleAsset(input.assetId)) {
    throw new RaceRuleError("INVALID_INPUT", "選択した障害物は設置できません");
  }
  if (![0, 1, 2].includes(input.lane) || !Number.isFinite(input.progress)) {
    throw new RaceRuleError("INVALID_INPUT", "レーンと設置位置を正しく指定してください");
  }
  if (input.route !== undefined && !["left", "right"].includes(input.route)) {
    throw new RaceRuleError("INVALID_INPUT", "分岐は左または右を指定してください");
  }
  if (typeof obstacleId !== "string" || !obstacleId.length || obstacleId.length > 128 || source.course.obstacles.some(obstacle => obstacle.id === obstacleId)) {
    throw new RaceRuleError("INVALID_INPUT", "障害物の識別子が無効です");
  }
  const state = advance(source, now);
  const at = state.updatedAt;
  if (state.version !== 2 || state.phase !== "racing") {
    throw new RaceRuleError("RACE_NOT_AVAILABLE", "障害物はレース中にのみ設置できます");
  }
  if (input.progress < 0 || input.progress > state.course.length - RACE_RULES.placementFinishMargin) {
    throw new RaceRuleError("INVALID_INPUT", "コース内のゴール手前3以上の位置を指定してください");
  }
  const placementAhead = racePaceRules(state).placementAhead;
  const minimum = Math.max(...IDS.map(id => state.players[id].progress)) + placementAhead;
  if (input.progress < minimum - EPSILON) {
    throw new RaceRuleError("RACE_NOT_AVAILABLE", `両車より${placementAhead}以上前方に設置してください`);
  }
  const junction = activeJunction(state.course, input.progress);
  if (junction && input.route === undefined) throw new RaceRuleError("INVALID_INPUT", "分岐内に設置する場合は左または右を選択してください");
  if (!junction && input.route !== undefined) throw new RaceRuleError("INVALID_INPUT", "分岐の外ではメインコースを選択してください");
  const placedCount = Math.max(state.placedObstacleCount ?? 0, state.course.obstacles.filter(obstacle => obstacle.placedAt !== undefined).length);
  if (placedCount >= RACE_RULES.placementMax) throw new RaceRuleError("RACE_NOT_AVAILABLE", "設置できる障害物は1レース20個までです");
  if (state.lastObstaclePlacedAt !== undefined && at < state.lastObstaclePlacedAt + RACE_RULES.placementCooldownMs) {
    throw new RaceRuleError("RACE_NOT_AVAILABLE", "連続設置は1.5秒以上間隔をあけてください");
  }
  const overlaps = state.course.obstacles.some(obstacle => {
    if (obstacle.blockedLane !== input.lane || Math.abs(obstacle.progress - input.progress) >= RACE_RULES.placementSpacing - EPSILON) return false;
    // Opposite branches are separate surfaces. At their entrance and merge,
    // retain the spacing from main-road obstacles on either side of the seam.
    return !(junction && obstacle.junctionId === junction.id && obstacle.route && obstacle.route !== input.route);
  });
  if (overlaps) throw new RaceRuleError("RACE_NOT_AVAILABLE", "同じレーンの障害物から4以上離して設置してください");
  const obstacle: Obstacle = {
    id: obstacleId, assetId: input.assetId, progress: input.progress, blockedLane: input.lane, placedAt: at,
    ...(junction ? { junctionId: junction.id, route: input.route } : {}),
  };
  let index = state.course.obstacles.findIndex(existing => existing.progress > obstacle.progress);
  if (index === -1) index = state.course.obstacles.length;
  state.course.obstacles.splice(index, 0, obstacle);
  for (const id of IDS) {
    // The cursor means "all earlier array entries have been passed/skipped".
    // Preserve those entries after insertion, while an insertion exactly at
    // the cursor remains unprocessed. Nothing rebuilds the cursor from a
    // selected route: that could skip newly added gates or replay old ones.
    if (index < state.players[id].nextObstacleIndex) state.players[id].nextObstacleIndex++;
  }
  state.lastObstaclePlacedAt = at;
  state.placedObstacleCount = placedCount + 1;
  log(state, { at, type: "obstacle_placed", obstacleId, assetId: input.assetId, lane: input.lane, progress: input.progress, ...(junction ? { junctionId: junction.id, route: input.route } : {}) });
  return state;
}

/** Validate and apply one persistent control. Call within your storage CAS loop. */
export function applyInput(source: RaceState, playerId: PlayerId, input: RaceInput, now: number): RaceState {
  if (!IDS.includes(playerId) || !input || typeof input !== "object") throw new RaceRuleError("INVALID_INPUT", "Invalid player or input");
  if (!["join", "ready", "lane", "speed", "route", "jump"].includes(input.type)) throw new RaceRuleError("INVALID_INPUT", "Unknown control");
  if (input.type === "lane" && ![0, 1, 2].includes(input.lane)) throw new RaceRuleError("INVALID_INPUT", "Lane must be 0, 1, or 2");
  if (input.type === "speed" && !["slow", "normal", "turbo"].includes(input.speed)) throw new RaceRuleError("INVALID_INPUT", "Unknown speed mode");
  if (input.type === "route" && (typeof input.junctionId !== "string" || !["left", "right"].includes(input.route))) throw new RaceRuleError("INVALID_INPUT", "Unknown route");

  const state = advance(source, now);
  const at = state.updatedAt;
  const player = state.players[playerId];
  if (state.phase === "cancelled") throw new RaceRuleError("RACE_FINISHED", "The race was cancelled");
  // Retries of successful join/ready operations are safe even after the race starts.
  if (input.type === "join" && player.joined) return state;
  if (input.type === "ready" && player.ready) return state;
  if (state.phase === "finished") throw new RaceRuleError("RACE_FINISHED", "The race has finished");
  if (input.type === "join") {
    if (state.phase !== "lobby") throw new RaceRuleError("RACE_NOT_AVAILABLE", "The race has already started");
    player.joined = true;
    log(state, { at, type: "joined", playerId });
    return state;
  }
  if (!player.joined) throw new RaceRuleError("PLAYER_NOT_JOINED", "Join the race before using controls");
  if (input.type === "ready") {
    if (state.phase !== "lobby") throw new RaceRuleError("RACE_NOT_AVAILABLE", "The race is no longer in the lobby");
    player.ready = true;
    log(state, { at, type: "ready", playerId });
    if (IDS.every((id) => state.players[id].ready)) {
      state.phase = "countdown";
      state.countdownEndsAt = at + RACE_RULES.countdownMs;
      log(state, { at, type: "countdown" });
    }
  } else if (input.type === "jump") {
    if (state.version !== 2 || state.phase !== "racing") throw new RaceRuleError("RACE_NOT_AVAILABLE", "ジャンプはレース中にのみ使用できます");
    if (isAirborne(player, at)) throw new RaceRuleError("RACE_NOT_AVAILABLE", "空中では再ジャンプできません");
    if (isSpinning(player, at)) throw new RaceRuleError("RACE_NOT_AVAILABLE", "スピンが終わるまでジャンプできません");
    if (at < (player.jumpReadyAt ?? 0)) throw new RaceRuleError("RACE_NOT_AVAILABLE", "着地から2秒後に再びジャンプできます");
    player.jumpStartedAt = at;
    player.jumpEndsAt = at + RACE_RULES.jumpMs;
    player.jumpReadyAt = player.jumpEndsAt + RACE_RULES.jumpCooldownMs;
    log(state, { at, type: "jump_started", playerId });
  } else if (input.type === "lane") {
    if (input.lane !== player.targetLane) {
      player.targetLane = input.lane;
      // Cars can be positioned while waiting; after the countdown they steer continuously.
      if (state.phase !== "racing") player.lane = input.lane;
      log(state, { at, type: "lane_change", playerId, lane: input.lane });
    }
  } else if (input.type === "speed") {
    if (input.speed !== player.speedMode) {
      player.speedMode = input.speed;
      log(state, { at, type: "speed_change", playerId, speedMode: input.speed });
    }
  } else if (input.type === "route") {
    const junction = state.version === 2 ? state.course.junctions?.find(j => j.id === input.junctionId) : undefined;
    if (!junction) throw new RaceRuleError("INVALID_INPUT", "Unknown junction");
    if (player.progress >= junction.start - EPSILON) throw new RaceRuleError("RACE_NOT_AVAILABLE", "The route is locked after entering the junction");
    player.routeChoices ??= {};
    if (player.routeChoices[junction.id] !== input.route) {
      player.routeChoices[junction.id] = input.route;
      log(state, { at, type: "route_change", playerId, junctionId: junction.id, route: input.route });
    }
  }
  return state;
}

/** Read model: no engine cursors; each driver's obstacle horizon follows the saved pace. */
export function publicView(source: RaceState): PublicRaceState {
  const state = copy(source);
  const paceRules = racePaceRules(state);
  const { carContact: _contact, ...visibleState } = state;
  const motion = state.version === 2 ? motionAt(state, state.updatedAt) : undefined;
  const playerView = (id: PlayerId): PublicRacer => {
    const { nextObstacleIndex: _cursor, ...player } = state.players[id];
    return {
      ...player,
      jumpAvailable: state.version === 2 && state.phase === "racing" && player.joined && !isAirborne(player, state.updatedAt) && !isSpinning(player, state.updatedAt) && state.updatedAt >= (player.jumpReadyAt ?? 0),
      jumpCooldownRemainingMs: Math.max(0, (player.jumpReadyAt ?? 0) - state.updatedAt),
      spinRemainingMs: Math.max(0, (player.spinEndsAt ?? 0) - state.updatedAt),
      speed: state.phase === "racing" ? motion?.speed[id] ?? movingSpeed(state.players[id], state.updatedAt) : 0,
      laneVelocity: state.phase === "racing" ? motion?.lane[id] ?? (Math.abs(player.targetLane - player.lane) > EPSILON ? Math.sign(player.targetLane - player.lane) * RACE_RULES.laneChangePerSecond : 0) : 0,
      upcomingObstacles: state.course.obstacles.filter((obstacle) => obstacle.progress > player.progress + EPSILON && obstacle.progress <= player.progress + paceRules.visibleDistance && (state.version === 1 || appliesToRoute(state, state.players[id], obstacle))),
    };
  };
  const red = playerView("red");
  const blue = playerView("blue");
  const minimum = Math.min(red.progress, blue.progress) - 5;
  const maximum = Math.max(red.progress, blue.progress) + paceRules.visibleDistance;
  return {
    ...visibleState,
    carInteraction: raceCarInteraction(state),
    paceRules: { ...paceRules },
    players: { red, blue },
    course: { ...state.course, obstacles: state.version === 2 ? state.course.obstacles : state.course.obstacles.filter((obstacle) => obstacle.progress >= minimum && obstacle.progress <= maximum) },
    remainingMs: state.phase === "finished" || state.phase === "cancelled" ? 0 : state.startedAt === null ? RACE_RULES.maxRaceMs : Math.max(0, state.startedAt + RACE_RULES.maxRaceMs - state.updatedAt),
  };
}
