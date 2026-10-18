/** Deterministic, wall-clock racing. Times are Unix milliseconds; distance is in track units. */
export type PlayerId = "red" | "blue";
export type Lane = 0 | 1 | 2;
export type SpeedMode = "slow" | "normal" | "turbo";
export type RacePhase = "lobby" | "countdown" | "racing" | "finished" | "cancelled";
export type RaceInput =
  | { type: "join" }
  | { type: "ready" }
  | { type: "lane"; lane: Lane }
  | { type: "speed"; speed: SpeedMode };

export const RACE_RULES = {
  length: 200,
  countdownMs: 15_000,
  maxRaceMs: 180_000,
  visibleDistance: 60,
  laneChangePerSecond: 1.6,
  collisionSlowMs: 4_000,
  collisionSpeedMultiplier: 0.4,
  collisionHalfWidth: 0.45,
  speeds: { slow: 1, normal: 1.8, turbo: 2.5 },
} as const;

export interface Obstacle {
  id: string;
  progress: number;
  blockedLane: Lane;
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
}

export interface RaceEvent {
  at: number;
  type: "joined" | "ready" | "countdown" | "race_started" | "lane_change" | "speed_change" | "collision" | "finished";
  playerId?: PlayerId;
  obstacleId?: string;
  lane?: Lane;
  speedMode?: SpeedMode;
}

export interface RaceState {
  version: 1;
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
  course: { length: number; obstacles: Obstacle[] };
  history: RaceEvent[];
}

export type PublicRacer = Omit<Racer, "nextObstacleIndex"> & {
  speed: number;
  upcomingObstacles: Obstacle[];
};
export type PublicRaceState = Omit<RaceState, "players"> & {
  players: Record<PlayerId, PublicRacer>;
  remainingMs: number;
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
    players: { red: { ...state.players.red }, blue: { ...state.players.blue } },
    course: { length: state.course.length, obstacles: state.course.obstacles.map((obstacle) => ({ ...obstacle })) },
    history: state.history.map((event) => ({ ...event })),
  };
}

function log(state: RaceState, event: RaceEvent): void {
  state.history.push(event);
  // Bound serialized storage even when an agent repeatedly changes its controls.
  if (state.history.length > 160) state.history.splice(0, state.history.length - 160);
}

function movingSpeed(player: Racer, at: number): number {
  return RACE_RULES.speeds[player.speedMode] * (at < player.slowedUntil - EPSILON ? RACE_RULES.collisionSpeedMultiplier : 1);
}

export function createRace(seed: string | number, now: number): RaceState {
  validTime(now);
  if ((typeof seed !== "string" && typeof seed !== "number") || (typeof seed === "number" && !Number.isFinite(seed))) {
    throw new RaceRuleError("INVALID_INPUT", "seed must be a string or finite number");
  }
  const seedText = String(seed);
  const random = rngFor(seedText);
  let previousLane: Lane | undefined;
  const obstacles = [25, 50, 75, 100, 125, 150, 175].map((progress, index) => {
    let lane = Math.floor(random() * 3) as Lane;
    if (lane === previousLane) lane = ((lane + 1 + Math.floor(random() * 2)) % 3) as Lane;
    previousLane = lane;
    return { id: `gate-${index + 1}`, progress, blockedLane: lane };
  });
  const player = (id: PlayerId, lane: Lane): Racer => ({
    id, name: id === "red" ? "RED" : "BLUE", joined: false, ready: false,
    progress: 0, lane, targetLane: lane, speedMode: "normal", collisionCount: 0,
    slowedUntil: 0, nextObstacleIndex: 0,
  });
  return {
    version: 1, seed: seedText, phase: "lobby", createdAt: now, updatedAt: now,
    countdownEndsAt: null, startedAt: null, finishedAt: null, finishReason: null, winner: null,
    players: { red: player("red", 0), blue: player("blue", 2) },
    course: { length: RACE_RULES.length, obstacles }, history: [],
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
export function advance(source: RaceState, now: number): RaceState {
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
    const deadline = state.startedAt + RACE_RULES.maxRaceMs;
    const until = Math.min(targetTime, deadline);
    while (cursor < until - EPSILON && state.phase === "racing") {
      let nextTime = until;
      const speeds = { red: movingSpeed(state.players.red, cursor), blue: movingSpeed(state.players.blue, cursor) };
      for (const id of IDS) {
        const player = state.players[id];
        if (player.slowedUntil > cursor + EPSILON) nextTime = Math.min(nextTime, player.slowedUntil);
        const nextGate = state.course.obstacles[player.nextObstacleIndex];
        if (nextGate) nextTime = Math.min(nextTime, cursor + Math.max(0, nextGate.progress - player.progress) / speeds[id] * 1000);
        nextTime = Math.min(nextTime, cursor + Math.max(0, state.course.length - player.progress) / speeds[id] * 1000);
      }

      const seconds = (nextTime - cursor) / 1000;
      for (const id of IDS) {
        const player = state.players[id];
        player.progress = Math.min(state.course.length, player.progress + speeds[id] * seconds);
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
            player.slowedUntil = cursor + RACE_RULES.collisionSlowMs;
            log(state, { at: cursor, type: "collision", playerId: id, obstacleId: gate.id });
          }
        }
      }
      if (IDS.some((id) => state.players[id].progress >= state.course.length - EPSILON)) finish(state, cursor, "finish_line");
    }
    if (state.phase === "racing" && targetTime >= deadline) finish(state, deadline, "time_limit");
  }
  state.updatedAt = targetTime;
  return state;
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

/** Validate and apply one persistent control. Call within your storage CAS loop. */
export function applyInput(source: RaceState, playerId: PlayerId, input: RaceInput, now: number): RaceState {
  if (!IDS.includes(playerId) || !input || typeof input !== "object") throw new RaceRuleError("INVALID_INPUT", "Invalid player or input");
  if (!["join", "ready", "lane", "speed"].includes(input.type)) throw new RaceRuleError("INVALID_INPUT", "Unknown control");
  if (input.type === "lane" && ![0, 1, 2].includes(input.lane)) throw new RaceRuleError("INVALID_INPUT", "Lane must be 0, 1, or 2");
  if (input.type === "speed" && !["slow", "normal", "turbo"].includes(input.speed)) throw new RaceRuleError("INVALID_INPUT", "Unknown speed mode");

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
  }
  return state;
}

/** Read model: no engine cursors, and only the next 60 units of obstacles per driver. */
export function publicView(source: RaceState): PublicRaceState {
  const state = copy(source);
  const playerView = (id: PlayerId): PublicRacer => {
    const { nextObstacleIndex: _cursor, ...player } = state.players[id];
    return {
      ...player,
      speed: state.phase === "racing" ? movingSpeed(state.players[id], state.updatedAt) : 0,
      upcomingObstacles: state.course.obstacles.filter((obstacle) => obstacle.progress > player.progress + EPSILON && obstacle.progress <= player.progress + RACE_RULES.visibleDistance),
    };
  };
  const red = playerView("red");
  const blue = playerView("blue");
  const minimum = Math.min(red.progress, blue.progress) - 5;
  const maximum = Math.max(red.progress, blue.progress) + RACE_RULES.visibleDistance;
  return {
    ...state,
    players: { red, blue },
    course: { length: state.course.length, obstacles: state.course.obstacles.filter((obstacle) => obstacle.progress >= minimum && obstacle.progress <= maximum) },
    remainingMs: state.phase === "finished" || state.phase === "cancelled" ? 0 : state.startedAt === null ? RACE_RULES.maxRaceMs : Math.max(0, state.startedAt + RACE_RULES.maxRaceMs - state.updatedAt),
  };
}
