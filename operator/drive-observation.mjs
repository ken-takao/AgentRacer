import manifest from '../public/roadster-circuit/props/manifest.json' with { type: 'json' };

export const OBSERVATION_MAX_AGE_MS = 2_000;
export const DECISION_MAX_AGE_MS = 3_000;
export const DRIVER_VISIBLE_DISTANCE = 60;
const SPRINT_VISIBLE_DISTANCE = 120;
const EPSILON = 1e-7;
const PHASES = ['lobby', 'countdown', 'racing', 'finished', 'cancelled'];
const SPEEDS = ['slow', 'normal', 'turbo'];
const ASSETS = new Set(manifest.filter(asset => asset.kind === 'obstacle').map(asset => asset.id));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const lane = value => [0, 1, 2].includes(value);
const side = value => value === 'left' || value === 'right';
const invalid = () => Object.assign(new Error('A valid driver observation is required.'), { code: 'invalid_observation' });
const requireThat = condition => { if (!condition) throw invalid(); };
const remaining = (end, now) => finite(end) ? Math.max(0, end - now) : 0;
const selectedRoute = (junction, driver) => driver.routeChoices?.[junction.id] ?? junction.defaultRoute;
const activeJunction = (junctions, progress) => junctions.find(j => progress >= j.start && progress < j.end);
const roadKey = (junctions, driver) => {
  const junction = activeJunction(junctions, driver.progress);
  return junction ? `${junction.id}:${selectedRoute(junction, driver)}` : 'main';
};

/** Keep this read model aligned with TacticalRoad, RivalRadar and RouteControls.
 * No full course obstacle array, history, player URLs, or arbitrary source text is copied.
 * observedAt is the local time BEFORE the state GET, so network delay counts as age.
 */
export function createDriveObservation({ state, color, observedAt }) {
  requireThat(['red', 'blue'].includes(color) && finite(observedAt) && observedAt >= 0);
  requireThat(state && PHASES.includes(state.phase) && finite(state.updatedAt));
  const mine = state.players?.[color], otherColor = color === 'red' ? 'blue' : 'red';
  const other = state.players?.[otherColor], course = state.course;
  const visibleDistance = state.version === 2 && state.pace === 'sprint-2x' ? SPRINT_VISIBLE_DISTANCE : DRIVER_VISIBLE_DISTANCE;
  if (state.paceRules) requireThat(state.paceRules.visibleDistance === visibleDistance);
  requireThat(mine && other && course && finite(course.length) && course.length > 0);
  for (const driver of [mine, other]) requireThat(finite(driver.progress) && finite(driver.lane) && driver.lane >= 0 && driver.lane <= 2);
  requireThat(lane(mine.targetLane) && SPEEDS.includes(mine.speedMode) && finite(mine.speed) && mine.speed >= 0 && Array.isArray(mine.upcomingObstacles));
  const junctions = course.junctions ?? [];
  requireThat(Array.isArray(junctions));
  for (const j of junctions) {
    requireThat(j && typeof j.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(j.id)
      && finite(j.start) && finite(j.end) && j.start < j.end && side(j.defaultRoute));
    for (const driver of [mine, other]) requireThat(side(selectedRoute(j, driver)));
  }
  const active = activeJunction(junctions, mine.progress);
  const junction = active ?? junctions.find(j => mine.progress < j.end);
  let route = null;
  if (junction) {
    const routes = {};
    for (const choice of ['left', 'right']) {
      const source = junction.routes?.[choice];
      requireThat(source && finite(source.speedMultiplier) && source.speedMultiplier > 0 && Array.isArray(source.blockedLanes) && source.blockedLanes.every(lane));
      // These lanes are shown in the route description/map; no hidden positions.
      routes[choice] = { speedMultiplier: source.speedMultiplier, obstacleCount: source.blockedLanes.length };
    }
    route = { junctionId: junction.id, number: junctions.indexOf(junction) + 1,
      selected: selectedRoute(junction, mine), defaultRoute: junction.defaultRoute,
      explicitChoice: mine.routeChoices?.[junction.id] != null,
      locked: mine.progress >= junction.start - EPSILON, phase: active ? 'branch' : 'approach',
      distanceToEntry: Math.max(0, junction.start - mine.progress),
      distanceToExit: active ? Math.max(0, junction.end - mine.progress) : null, routes };
  }
  const gap = other.progress - mine.progress;
  const sameRoad = roadKey(junctions, mine) === roadKey(junctions, other);
  const obstacles = mine.upcomingObstacles.filter(obstacle => {
    if (!obstacle || !finite(obstacle.progress) || !lane(obstacle.blockedLane)) return false;
    const distance = obstacle.progress - mine.progress;
    if (distance <= EPSILON || distance > visibleDistance) return false;
    if (state.version === 1 || !obstacle.junctionId || !obstacle.route) return true;
    const branch = junctions.find(j => j.id === obstacle.junctionId);
    return !!branch && selectedRoute(branch, mine) === obstacle.route;
  }).sort((a, b) => a.progress - b.progress).map(obstacle => ({
    distance: obstacle.progress - mine.progress, lane: obstacle.blockedLane,
    kind: obstacle.assetId === 'banana_peel' ? 'banana' : 'obstacle',
    ...(ASSETS.has(obstacle.assetId) ? { asset: obstacle.assetId } : {}),
  }));
  return sanitizeDriveObservation({ schema: 'driver-observation-v1', color, observedAt, stateAt: state.updatedAt, phase: state.phase,
    carInteraction: state.version === 2 && state.carInteraction === 'ghost' ? 'ghost' : 'solid',
    course: { length: course.length, visibleDistance },
    driver: { progress: mine.progress, lane: mine.lane, targetLane: mine.targetLane, speedMode: mine.speedMode, speed: mine.speed,
      joined: mine.joined === true, ready: mine.ready === true,
      jumpAvailable: mine.jumpAvailable === true, jumpRemainingMs: remaining(mine.jumpEndsAt, state.updatedAt),
      jumpCooldownRemainingMs: remaining(mine.jumpReadyAt, state.updatedAt), spinRemainingMs: remaining(mine.spinEndsAt, state.updatedAt),
      slowed: remaining(mine.slowedUntil, state.updatedAt) > 0 },
    road: { kind: active ? 'branch' : 'main', route: active ? selectedRoute(active, mine) : null },
    rival: { color: otherColor, distance: gap, lane: other.lane, sameRoad,
      frontViewVisible: sameRoad && gap >= -4 && gap <= visibleDistance },
    obstacles, route });
}

/** Rebuild even already-created observations so unexpected fields never reach the API. */
export function sanitizeDriveObservation(value) {
  requireThat(value && value.schema === 'driver-observation-v1' && ['red', 'blue'].includes(value.color)
    && finite(value.observedAt) && value.observedAt >= 0 && finite(value.stateAt) && PHASES.includes(value.phase));
  requireThat(value.carInteraction === undefined || ['solid', 'ghost'].includes(value.carInteraction));
  const { driver: d, course: c, rival: r, road, route } = value;
  requireThat(c && finite(c.length) && c.length > 0 && [DRIVER_VISIBLE_DISTANCE, SPRINT_VISIBLE_DISTANCE].includes(c.visibleDistance));
  requireThat(d && finite(d.progress) && finite(d.lane) && d.lane >= 0 && d.lane <= 2 && lane(d.targetLane)
    && SPEEDS.includes(d.speedMode) && finite(d.speed) && d.speed >= 0);
  for (const key of ['joined', 'ready', 'jumpAvailable', 'slowed']) requireThat(typeof d[key] === 'boolean');
  for (const key of ['jumpRemainingMs', 'jumpCooldownRemainingMs', 'spinRemainingMs']) requireThat(finite(d[key]) && d[key] >= 0);
  requireThat(r && r.color === (value.color === 'red' ? 'blue' : 'red') && finite(r.distance) && finite(r.lane) && r.lane >= 0 && r.lane <= 2 && typeof r.sameRoad === 'boolean');
  requireThat(road && ['main', 'branch'].includes(road.kind) && (road.kind === 'main' ? road.route === null : side(road.route)));
  requireThat(Array.isArray(value.obstacles) && value.obstacles.length <= 64);
  const obstacles = value.obstacles.map(o => {
    requireThat(o && finite(o.distance) && o.distance > EPSILON && o.distance <= c.visibleDistance && lane(o.lane) && ['banana', 'obstacle'].includes(o.kind));
    return { distance: o.distance, lane: o.lane, kind: o.kind, ...(ASSETS.has(o.asset) ? { asset: o.asset } : {}) };
  });
  let cleanRoute = null;
  if (route !== null) {
    requireThat(route && typeof route.junctionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(route.junctionId)
      && Number.isInteger(route.number) && route.number > 0 && side(route.selected) && side(route.defaultRoute)
      && typeof route.explicitChoice === 'boolean' && typeof route.locked === 'boolean' && ['branch', 'approach'].includes(route.phase)
      && finite(route.distanceToEntry) && route.distanceToEntry >= 0
      && (route.phase === 'branch' ? finite(route.distanceToExit) && route.distanceToExit >= 0 : route.distanceToExit === null));
    const routes = {};
    for (const choice of ['left', 'right']) {
      const info = route.routes?.[choice];
      requireThat(info && finite(info.speedMultiplier) && info.speedMultiplier > 0 && Number.isInteger(info.obstacleCount) && info.obstacleCount >= 0);
      routes[choice] = { speedMultiplier: info.speedMultiplier, obstacleCount: info.obstacleCount };
    }
    cleanRoute = { junctionId: route.junctionId, number: route.number, selected: route.selected, defaultRoute: route.defaultRoute,
      explicitChoice: route.explicitChoice, locked: route.locked, phase: route.phase,
      distanceToEntry: route.distanceToEntry, distanceToExit: route.distanceToExit, routes };
  }
  return { schema: 'driver-observation-v1', color: value.color, observedAt: value.observedAt, stateAt: value.stateAt, phase: value.phase,
    carInteraction: value.carInteraction ?? 'solid',
    course: { length: c.length, visibleDistance: c.visibleDistance },
    driver: { progress: d.progress, lane: d.lane, targetLane: d.targetLane, speedMode: d.speedMode, speed: d.speed,
      joined: d.joined, ready: d.ready, jumpAvailable: d.jumpAvailable, jumpRemainingMs: d.jumpRemainingMs,
      jumpCooldownRemainingMs: d.jumpCooldownRemainingMs, spinRemainingMs: d.spinRemainingMs, slowed: d.slowed },
    road: { kind: road.kind, route: road.route },
    rival: { color: r.color, distance: r.distance, lane: r.lane, sameRoad: r.sameRoad,
      frontViewVisible: r.sameRoad && r.distance >= -4 && r.distance <= c.visibleDistance }, obstacles, route: cleanRoute };
}

export function expectedInputForAction(action, observation) {
  const lanes = { lane_left: 0, lane_center: 1, lane_right: 2 };
  if (Object.hasOwn(lanes, action)) return { type: 'lane', lane: lanes[action] };
  if (['speed_slow', 'speed_normal', 'speed_turbo'].includes(action)) return { type: 'speed', speed: action.slice(6) };
  if (['route_left', 'route_right'].includes(action) && observation?.route) return { type: 'route', junctionId: observation.route.junctionId, route: action.slice(6) };
  if (action === 'jump') return { type: 'jump' };
  return null;
}

/** Validate legality only; do not replace the model's strategy using risk thresholds. */
export function driveActionStatus(action, observation) {
  const o = sanitizeDriveObservation(observation);
  if (action === 'wait') return { valid: true, reason: 'wait', input: null };
  const input = expectedInputForAction(action, o);
  const reject = reason => ({ valid: false, reason, input });
  if (!input) return reject(['route_left', 'route_right'].includes(action) ? 'no_route' : 'invalid_action');
  if (!['lobby', 'countdown', 'racing'].includes(o.phase)) return reject('race_finished');
  if (!o.driver.joined) return reject('not_joined');
  if (input.type === 'jump') {
    if (o.phase !== 'racing' || !o.driver.jumpAvailable || o.driver.spinRemainingMs > 0 || o.driver.jumpRemainingMs > 0 || o.driver.jumpCooldownRemainingMs > 0) return reject('jump_unavailable');
  } else if (input.type === 'lane' && input.lane === o.driver.targetLane) return reject('same_setting');
  else if (input.type === 'speed' && input.speed === o.driver.speedMode) return reject('same_setting');
  else if (input.type === 'route') {
    if (o.route.locked) return reject('route_locked');
    if (input.route === o.route.selected) return reject('same_setting');
  }
  return { valid: true, reason: 'allowed', input };
}
