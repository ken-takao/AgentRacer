import type { CourseFeatures, CourseJunction, CourseLayout, RouteChoice } from "./race-course";

/** Spectator coordinates preserve server distance, lane and route choices. */
export const CIRCUIT_3D = { straight: 56, radius: 21, laneWidth: 4.2, halfWidth: 6.3 } as const;
const { straight, radius, laneWidth } = CIRCUIT_3D;
export const CIRCUIT_LAP_DISTANCE = 2 * straight + 2 * Math.PI * radius;
export type CircuitPoint = { x: number; y: number; z: number; heading: number; slope: number };
type Vec = { x: number; y: number; z: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const safeLength = (length: number) => Number.isFinite(length) && length > 0 ? length : 200;

/** Bounds include both fork roads and track furniture. */
export function circuitBounds(course?: CourseFeatures) {
  return course?.layout ? { width: 246, depth: 154 } : { width: 132, depth: 82 };
}

// All three layouts cross at the centre, once on a bridge and once at ground level.
// Additional alternating bends make the approach to each fork distinct.
const layoutPoints: Record<CourseLayout, number[][]> = {
  harbor: [[-76,0,38],[-37,3,39],[0,14,0],[35,3,-36],[76,0,-39],[94,0,-8],[67,0,19],[35,0,22],[0,0,0],[-35,0,-31],[-77,0,-32],[-99,0,0]],
  alpine: [[-76,0,41],[-37,3,33],[0,14,0],[31,3,-43],[72,0,-48],[94,0,-13],[70,0,13],[35,0,28],[0,0,0],[-37,0,-25],[-80,0,-42],[-98,0,-1]],
  metro: [[-76,0,37],[-37,3,45],[0,14,0],[35,3,-31],[81,0,-38],[91,0,-6],[62,0,22],[35,0,17],[0,0,0],[-32,0,-39],[-80,0,-29],[-102,0,3]],
};
type ArcTable = { positions: Vec[]; distances: number[]; length: number };
const tables = new Map<CourseLayout, ArcTable>();
function spline(layout: CourseLayout, fraction: number): Vec {
  const points = layoutPoints[layout];
  const parameter = (((fraction % 1) + 1) % 1) * points.length;
  const index = Math.floor(parameter), t = parameter - index;
  const v = [-1, 0, 1, 2].map(offset => points[(index + offset + points.length) % points.length]);
  const coordinate = (axis: number) => 0.5 * ((2 * v[1][axis]) + (-v[0][axis] + v[2][axis]) * t + (2 * v[0][axis] - 5 * v[1][axis] + 4 * v[2][axis] - v[3][axis]) * t * t + (-v[0][axis] + 3 * v[1][axis] - 3 * v[2][axis] + v[3][axis]) * t * t * t);
  return { x: coordinate(0), y: Math.max(0, coordinate(1)), z: coordinate(2) };
}
function arcTable(layout: CourseLayout): ArcTable {
  const existing = tables.get(layout);
  if (existing) return existing;
  const positions: Vec[] = [], distances = [0];
  for (let i = 0; i <= 1600; i++) {
    const p = spline(layout, i / 1600);
    if (i) {
      const previous = positions[i - 1];
      distances.push(distances[i - 1] + Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z));
    }
    positions.push(p);
  }
  const table = { positions, distances, length: distances[distances.length - 1] };
  tables.set(layout, table);
  return table;
}
function centre(layout: CourseLayout, fraction: number): Vec {
  const table = arcTable(layout);
  const distance = (((fraction % 1) + 1) % 1) * table.length;
  let lo = 0, hi = table.distances.length - 1;
  while (hi - lo > 1) {
    const middle = (lo + hi) >>> 1;
    if (table.distances[middle] > distance) hi = middle; else lo = middle;
  }
  const t = (distance - table.distances[lo]) / (table.distances[hi] - table.distances[lo]);
  // Interpolate the arc parameter, then evaluate the smooth spline itself.
  // Linear interpolation of sampled positions would make fork normals jitter.
  return spline(layout, (lo + t) / (table.positions.length - 1));
}
// A single cross-section frame is shared by both fork roads. Offsetting each
// independently curved road by another normal used to fold the inner ribbon
// backwards (the tightest radius was 0.21 m for a 7.6 m shoulder).
const forkHandles: Record<CourseLayout, readonly [readonly [number, number], readonly [number, number]]> = {
  harbor: [[0.55, 0.325], [0.3, 0.425]],
  alpine: [[0.6, 0.4], [0.225, 0.475]],
  metro: [[0.6, 0.275], [0.3, 0.425]],
};
export const CIRCUIT_ROAD_SURFACE = 0.02;
const FORK_SPREAD = 13.5;
const SHOULDER_WIDTH = 7.6;
const smoothstep = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const difference = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const unit = (v: Vec): Vec => { const n = Math.hypot(v.x, v.y, v.z); return { x: v.x / n, y: v.y / n, z: v.z / n }; };
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
function mainFrame(layout: CourseLayout, fraction: number) {
  const p = centre(layout, fraction), a = centre(layout, fraction - 0.00001), b = centre(layout, fraction + 0.00001);
  const derivative = difference(b, a);
  return { p, heading: Math.atan2(derivative.z, derivative.x), slope: Math.atan2(derivative.y, Math.hypot(derivative.x, derivative.z)), speed: Math.hypot(derivative.x, derivative.z) / 0.00002 };
}
type ForkCurve = { a: ReturnType<typeof mainFrame>; b: ReturnType<typeof mainFrame>; c: Vec; d: Vec; startRate: number; endRate: number; heightPower: number };
const forkCurves = new Map<string, ForkCurve>();
function forkCurve(course: CourseFeatures, junction: CourseJunction, length: number): ForkCurve {
  const layout = course.layout!, start = junction.start / length, end = junction.end / length;
  const index = Math.max(0, (course.junctions ?? []).indexOf(junction)) % 2;
  const key = `${layout}:${start}:${end}:${index}`;
  const found = forkCurves.get(key); if (found) return found;
  const a = mainFrame(layout, start), b = mainFrame(layout, end);
  const span = end - start, distance = arcTable(layout).length * span;
  const [first, last] = forkHandles[layout][index];
  const h1 = first * distance, h2 = last * distance;
  const c = { x: a.p.x + Math.cos(a.heading) * h1, y: a.p.y + Math.tan(a.slope) * h1, z: a.p.z + Math.sin(a.heading) * h1 };
  const d = { x: b.p.x - Math.cos(b.heading) * h2, y: b.p.y - Math.tan(b.slope) * h2, z: b.p.z - Math.sin(b.heading) * h2 };
  const result = { a, b, c, d, startRate: a.speed * span / (3 * h1), endRate: b.speed * span / (3 * h2), heightPower: a.p.y > 0 && b.p.y < 1e-8 ? -Math.tan(a.slope) * 3 * h1 / a.p.y : 0 };
  forkCurves.set(key, result); return result;
}
function forkBase(course: CourseFeatures, junction: CourseJunction, fraction: number, length: number) {
  const amount = clamp((fraction * length - junction.start) / (junction.end - junction.start), 0, 1);
  const curve = forkCurve(course, junction, length), { a, b, c, d } = curve;
  // This monotone Hermite parameter retains the original endpoint velocities.
  // Together with the endpoint cross-section frame it preserves every lane's
  // first derivative, not merely the centre of the road.
  const q = amount, q2 = q * q, q3 = q2 * q;
  const t = (-2 * q3 + 3 * q2) + (q3 - 2 * q2 + q) * curve.startRate + (q3 - q2) * curve.endRate;
  const inv = 1 - t;
  const coordinate = (axis: keyof Vec) => inv ** 3 * a.p[axis] + 3 * inv ** 2 * t * c[axis] + 3 * inv * t * t * d[axis] + t ** 3 * b.p[axis];
  const tangent = (axis: keyof Vec) => 3 * inv * inv * (c[axis] - a.p[axis]) + 6 * inv * t * (d[axis] - c[axis]) + 3 * t * t * (b.p[axis] - d[axis]);
  const p = { x: coordinate("x"), y: coordinate("y"), z: coordinate("z") };
  // A high bridge approach must descend without the negative-height overshoot
  // produced by an unconstrained cubic's vertical control points.
  if (curve.heightPower >= 2) p.y = a.p.y * inv ** curve.heightPower;
  const original = mainFrame(course.layout!, fraction).heading;
  const curved = Math.atan2(tangent("z"), tangent("x"));
  const blend = smoothstep(amount / 0.2) * smoothstep((1 - amount) / 0.2);
  const heading = original + Math.atan2(Math.sin(curved - original), Math.cos(curved - original)) * blend;
  return { p, heading, amount };
}
function forkAt(course: CourseFeatures, progress: number) {
  return course.junctions?.find(j => progress >= j.start && progress <= j.end && j.end > j.start);
}
function surfacePoint(fraction: number, offset: number, length: number, course: CourseFeatures, routes: Record<string, RouteChoice>): Vec {
  const junction = forkAt(course, fraction * length);
  let p: Vec, heading: number, lateral = offset;
  if (junction) {
    const base = forkBase(course, junction, fraction, length), choice = routes[junction.id] ?? junction.defaultRoute;
    const spread = Math.sin(Math.PI * base.amount) ** 2;
    lateral += (choice === "left" ? -1 : 1) * FORK_SPREAD * spread;
    // Until both full shoulders separate, the two roads share one ruled
    // surface. Only an independent branch may gain its decorative elevation.
    const rise = smoothstep((FORK_SPREAD * spread - SHOULDER_WIDTH) / (FORK_SPREAD - SHOULDER_WIDTH));
    p = { ...base.p, y: base.p.y + (choice === "left" ? 1.8 : 0.25) * rise };
    heading = base.heading;
  } else { const base = mainFrame(course.layout!, fraction); p = base.p; heading = base.heading; }
  return { x: p.x - Math.sin(heading) * lateral, y: p.y, z: p.z + Math.cos(heading) * lateral };
}

/**
 * Clip a branch's inner edge at the common cross-section centre while its road
 * overlaps the other branch. Explicit route maps identify branch mesh sections;
 * a main-road section (routes={}) always retains its full width at the join.
 * The returned offsets are relative to that branch and feed circuitAtProgress.
 */
export function circuitRoadEdges(progress: number, halfWidth: number, courseLength: number, course?: CourseFeatures, routes: Record<string, RouteChoice> = {}): readonly [number, number] {
  const junction = course && forkAt(course, progress), width = Math.max(0, finite(halfWidth));
  if (!junction || !Object.hasOwn(routes, junction.id)) return [-width, width];
  const t = clamp((progress - junction.start) / (junction.end - junction.start), 0, 1);
  const sharedEdge = FORK_SPREAD * Math.sin(Math.PI * t) ** 2;
  return routes[junction.id] === "left" ? [-width, Math.min(width, sharedEdge)] : [Math.max(-width, -sharedEdge), width];
}

/**
 * Inner furniture stays hidden until its entire footprint clears the split.
 * clearance is the local footprint radius (hypot of half-length/half-width),
 * not an extra offset applied to its rendered position.
 */
export function circuitEdgeExposed(progress: number, offset: number, courseLength: number, course?: CourseFeatures, routes: Record<string, RouteChoice> = {}, clearance = 0): boolean {
  const junction = course && forkAt(course, progress);
  if (!junction || !Object.hasOwn(routes, junction.id)) return true;
  const inner = routes[junction.id] === "left" ? offset > 0 : offset < 0;
  if (!inner) return true;
  const extent = Math.abs(offset) + Math.max(0, finite(clearance));
  const [low, high] = circuitRoadEdges(progress, extent, courseLength, course, routes);
  return offset > 0 ? high >= extent - 1e-8 : low <= -extent + 1e-8;
}

/** A lane is always on its chosen road; no presentation offsets hide vehicle contact. */
export function circuitPosition(progress: number, lane: number, courseLength: number, course?: CourseFeatures, routes: Record<string, RouteChoice> = {}): CircuitPoint {
  const length = safeLength(courseLength);
  const fraction = clamp(finite(progress) / length, 0, 1);
  const offset = (clamp(finite(lane, 1), 0, 2) - 1) * laneWidth;
  if (!course?.layout || !(course.layout in layoutPoints)) return circuitAtDistance(fraction * CIRCUIT_LAP_DISTANCE + straight / 2, offset);
  return complexPosition(fraction, offset, length, course, routes);
}
function complexPosition(fraction: number, offset: number, length: number, course: CourseFeatures, routes: Record<string, RouteChoice>): CircuitPoint {
  const p = surfacePoint(fraction, offset, length, course, routes);
  const a = surfacePoint(fraction - 0.000001, offset, length, course, routes), b = surfacePoint(fraction + 0.000001, offset, length, course, routes);
  const heading = Math.atan2(b.z - a.z, b.x - a.x);
  const slope = Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z));
  return { ...p, heading, slope };
}

/** Exact local surface basis at a ribbon offset (not a lane index). */
export function circuitSurfaceFrame(progress: number, offset: number, courseLength: number, course?: CourseFeatures, routes: Record<string, RouteChoice> = {}) {
  const length = safeLength(courseLength), fraction = clamp(finite(progress) / length, 0, 1);
  if (!course?.layout || !(course.layout in layoutPoints)) {
    const p = circuitAtProgress(progress, offset, length, course, routes);
    return { forward: { x: Math.cos(p.heading), y: 0, z: Math.sin(p.heading) }, normal: { x: 0, y: 1, z: 0 }, right: { x: -Math.sin(p.heading), y: 0, z: Math.cos(p.heading) } };
  }
  const ahead = surfacePoint(fraction + 0.000001, offset, length, course, routes), behind = surfacePoint(fraction - 0.000001, offset, length, course, routes);
  const left = surfacePoint(fraction, offset - 0.001, length, course, routes), right = surfacePoint(fraction, offset + 0.001, length, course, routes);
  const forward = unit(difference(ahead, behind)), lateral = unit(difference(right, left));
  const normal = unit(cross(lateral, forward));
  return { forward, normal, right: unit(cross(forward, normal)) };
}

/** Ribbon construction uses the same normalized centreline and fork selection as cars. */
export function circuitAtProgress(progress: number, offset: number, courseLength: number, course?: CourseFeatures, routes: Record<string, RouteChoice> = {}): CircuitPoint {
  const length = safeLength(courseLength), fraction = clamp(finite(progress) / length, 0, 1);
  return course?.layout && course.layout in layoutPoints
    ? complexPosition(fraction, finite(offset), length, course, routes)
    : circuitAtDistance(fraction * CIRCUIT_LAP_DISTANCE + straight / 2, offset);
}

/** Legacy oval, retained so existing races still match their original course. */
export function circuitAtDistance(distance: number, offset = 0): CircuitPoint {
  const d = ((finite(distance) % CIRCUIT_LAP_DISTANCE) + CIRCUIT_LAP_DISTANCE) % CIRCUIT_LAP_DISTANCE;
  const r = radius + finite(offset);
  if (d < straight) return { x: -straight / 2 + d, y: 0, z: r, heading: 0, slope: 0 };
  if (d < straight + Math.PI * radius) {
    const angle = Math.PI / 2 - (d - straight) / radius;
    return { x: straight / 2 + Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r, heading: angle - Math.PI / 2, slope: 0 };
  }
  if (d < 2 * straight + Math.PI * radius) return { x: straight / 2 - (d - straight - Math.PI * radius), y: 0, z: -r, heading: Math.PI, slope: 0 };
  const angle = -Math.PI / 2 - (d - 2 * straight - Math.PI * radius) / radius;
  return { x: -straight / 2 + Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r, heading: angle - Math.PI / 2, slope: 0 };
}
