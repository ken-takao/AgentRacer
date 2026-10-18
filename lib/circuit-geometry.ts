import type { CourseFeatures, CourseLayout, RouteChoice } from "./race-course";

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
function routedCentre(fraction: number, length: number, course: CourseFeatures, routes: Record<string, RouteChoice>): Vec {
  const layout = course.layout!;
  const p = centre(layout, fraction);
  const junction = course.junctions?.find(j => fraction * length >= j.start && fraction * length <= j.end);
  if (!junction || junction.end <= junction.start) return p;
  const amount = clamp((fraction * length - junction.start) / (junction.end - junction.start), 0, 1);
  // Zero displacement and zero derivative at both ends make the split/merge continuous.
  const spread = Math.sin(Math.PI * amount) ** 2;
  const before = centre(layout, fraction - 0.0001), after = centre(layout, fraction + 0.0001);
  const heading = Math.atan2(after.z - before.z, after.x - before.x);
  const route = routes[junction.id] ?? junction.defaultRoute;
  const offset = (route === "left" ? -1 : 1) * 13.5 * spread;
  return { x: p.x - Math.sin(heading) * offset, y: p.y + (route === "left" ? 1.8 : 0.25) * spread, z: p.z + Math.cos(heading) * offset };
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
  const p = routedCentre(fraction, length, course, routes);
  const a = routedCentre(fraction - 0.00001, length, course, routes), b = routedCentre(fraction + 0.00001, length, course, routes);
  const heading = Math.atan2(b.z - a.z, b.x - a.x);
  const slope = Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z));
  return { x: p.x - Math.sin(heading) * offset, y: p.y, z: p.z + Math.cos(heading) * offset, heading, slope };
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
