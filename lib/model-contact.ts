/** Asset bounds and road frames are kept independent of Three.js for verification. */
export type ContactVector = { x: number; y: number; z: number };
export type ModelBounds = { min: ContactVector; max: ContactVector };
export type ContactPoint = {
  heading: number;
  slope: number;
  forward?: ContactVector;
  normal?: ContactVector;
};

const dot = (a: ContactVector, b: ContactVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: ContactVector, b: ContactVector): ContactVector => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function unit(v: ContactVector): ContactVector {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(length) || length < 1e-10) throw new RangeError("A surface frame needs finite, nonzero axes");
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * Call after the asset's display scale and authored-axis rotation have been
 * applied, before any road pitch. Unlike a common vertical lift, this removes
 * each asset's measured empty space below its own geometry. Centering the
 * footprint also keeps the visual obstacle over its authoritative lane point.
 */
export function modelGroundingOffset(bounds: ModelBounds): ContactVector {
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) || bounds.max[axis] < bounds.min[axis]) {
      throw new RangeError("Model bounds must be finite and ordered");
    }
  }
  return {
    x: -(bounds.min.x + bounds.max.x) / 2,
    y: -bounds.min.y,
    z: -(bounds.min.z + bounds.max.z) / 2,
  };
}

/**
 * A right-handed local basis: +X forward, +Y out of the road, +Z right.
 * Prefer the exact ribbon frame when provided; heading/slope support the legacy
 * oval. yawOffset rotates around the ROAD normal, so a spinning car stays flat
 * against an incline. A Roadster authored with its nose at -X uses Math.PI.
 */
export function surfaceFrame(point: ContactPoint, yawOffset = 0) {
  if (![point.heading, point.slope, yawOffset].every(Number.isFinite)) throw new RangeError("Surface angles must be finite");
  const ch = Math.cos(point.heading), sh = Math.sin(point.heading);
  const cs = Math.cos(point.slope), ss = Math.sin(point.slope);
  const normal = unit(point.normal ?? { x: -ch * ss, y: cs, z: -sh * ss });
  const tangent = point.forward ?? { x: ch * cs, y: ss, z: sh * cs };
  // Remove small numerical normal components before constructing the basis.
  const normalComponent = dot(tangent, normal);
  const forward = unit({ x: tangent.x - normal.x * normalComponent, y: tangent.y - normal.y * normalComponent, z: tangent.z - normal.z * normalComponent });
  const right = unit(cross(forward, normal));
  const c = Math.cos(yawOffset), s = Math.sin(yawOffset);
  return {
    forward: { x: forward.x * c - right.x * s, y: forward.y * c - right.y * s, z: forward.z * c - right.z * s },
    normal,
    right: { x: forward.x * s + right.x * c, y: forward.y * s + right.y * c, z: forward.z * s + right.z * c },
  };
}

/** Cache a small lower-envelope sample set once, in normalized model space. */
export function modelSupportPoints(vertices: readonly ContactVector[]): ContactVector[] {
  if (!vertices.length) return [];
  const bounds = vertices.reduce((b, p) => ({
    min: { x: Math.min(b.min.x, p.x), y: Math.min(b.min.y, p.y), z: Math.min(b.min.z, p.z) },
    max: { x: Math.max(b.max.x, p.x), y: Math.max(b.max.y, p.y), z: Math.max(b.max.z, p.z) },
  }), { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } });
  const bins = new Map<string, ContactVector>(), bottom = new Map<string, ContactVector>();
  for (const p of vertices) {
    if (![p.x, p.y, p.z].every(Number.isFinite)) throw new RangeError("Model support points must be finite");
    const ix = Math.min(3, Math.floor((p.x - bounds.min.x) / Math.max(1e-8, bounds.max.x - bounds.min.x) * 4));
    const iz = Math.min(3, Math.floor((p.z - bounds.min.z) / Math.max(1e-8, bounds.max.z - bounds.min.z) * 4));
    const key = `${ix}:${iz}`;
    if (!bins.has(key) || bins.get(key)!.y > p.y) bins.set(key, p);
    if (p.y - bounds.min.y < 1e-5) bottom.set(`${p.x.toFixed(6)}:${p.z.toFixed(6)}`, p);
  }
  const unique = new Map<string, ContactVector>();
  for (const p of [...bins.values(), ...bottom.values()]) unique.set(`${p.x.toFixed(6)}:${p.y.toFixed(6)}:${p.z.toFixed(6)}`, { ...p });
  return [...unique.values()];
}

export type RoadSupportInput = {
  progress: number;
  offset: number;
  length: number;
  point: ContactVector;
  frame: ReturnType<typeof surfaceFrame>;
  supportPoints: readonly ContactVector[];
  /** Same selected route and surface as the road mesh, without an added lift. */
  sampleSurface: (progress: number, offset: number) => ContactVector;
};

/**
 * A rigid model on a curved road needs a tiny geometry-derived lift in addition
 * to its tangent-plane rotation. Solve locally around the known progress, never
 * search other roads at a crossover. Static obstacles calculate this once;
 * cars reuse their cached support points. No authoritative coordinates change.
 */
export function roadModelSupport({ progress, offset, length, point, frame, supportPoints, sampleSurface }: RoadSupportInput): number {
  if (!supportPoints.length) return 0;
  if (!Number.isFinite(length) || length <= 0 || frame.normal.y <= 1e-5) throw new RangeError("Road support requires a finite upward surface");
  const sample = (p: number, o: number) => sampleSurface(((p % length) + length) % length, o);
  const surfaceHeight = (x: number, z: number) => {
    let p = progress, o = offset;
    for (let iteration = 0; iteration < 5; iteration++) {
      const here = sample(p, o), dx = x - here.x, dz = z - here.z;
      if (Math.hypot(dx, dz) < 1e-5) return here.y;
      const ahead = sample(p + .001, o), side = sample(p, o + .001);
      const px = (ahead.x - here.x) / .001, pz = (ahead.z - here.z) / .001;
      const ox = (side.x - here.x) / .001, oz = (side.z - here.z) / .001;
      const determinant = px * oz - pz * ox;
      if (Math.abs(determinant) < 1e-8) return here.y;
      p += Math.max(-4, Math.min(4, (dx * oz - dz * ox) / determinant));
      o += Math.max(-4, Math.min(4, (px * dz - pz * dx) / determinant));
    }
    return sample(p, o).y;
  };
  const transformed = supportPoints.map(p => ({
    x: point.x + frame.forward.x * p.x + frame.normal.x * p.y + frame.right.x * p.z,
    y: point.y + frame.forward.y * p.x + frame.normal.y * p.y + frame.right.y * p.z,
    z: point.z + frame.forward.z * p.x + frame.normal.z * p.y + frame.right.z * p.z,
  }));
  let lift = 0;
  // The correction also moves slightly sideways on an incline. Reproject it so
  // the reported lift matches the actual translated model, not its old X/Z.
  for (let pass = 0; pass < 3; pass++) {
    let correction = 0;
    for (const p of transformed) {
      const x = p.x + frame.normal.x * lift, y = p.y + frame.normal.y * lift, z = p.z + frame.normal.z * lift;
      correction = Math.max(correction, (surfaceHeight(x, z) - y) / frame.normal.y);
    }
    lift += correction;
    if (correction < 1e-5) break;
  }
  return lift;
}
