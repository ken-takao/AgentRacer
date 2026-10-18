export type CameraAnchor = { x: number; y?: number; z: number; heading: number; slope?: number; speed?: number };
export type CameraShot = { key: string; label: string; kind: "overview" | "chase" | "side" | "duel" | "grid"; focus?: 0 | 1 };
export type CameraPose = { eye: [number, number, number]; target: [number, number, number]; fov: number };
const driverName = (focus: 0 | 1) => focus === 0 ? "SCARLET" : "COBALT";
const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? value as number : fallback;
const safeAnchor = (anchor?: CameraAnchor) => ({ x: finite(anchor?.x), y: finite(anchor?.y), z: finite(anchor?.z), heading: finite(anchor?.heading), slope: finite(anchor?.slope), speed: finite(anchor?.speed) });

/** Smooth orientation without interpolating the camera through the tracked vehicle. */
export function smoothCameraHeading(previous: number, current: number, dt: number): number {
  if (!Number.isFinite(previous)) return finite(current);
  const delta = Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
  return previous + delta * (1 - Math.exp(-Math.max(0, finite(dt)) * 12));
}

/** A 40-second broadcast cycle spends 37 seconds near the cars, 3 on the full circuit. */
export function selectAutoShot(phase: string, seconds: number, anchors: CameraAnchor[], progress: number[]): CameraShot {
  if (phase === "countdown" || phase === "lobby") return { key: "grid", label: phase === "lobby" ? "GRID FORMING" : "STARTING GRID", kind: "grid" };
  if (phase !== "racing") return { key: "overview", label: "CIRCUIT VIEW", kind: "overview" };
  const t = ((finite(seconds) % 40) + 40) % 40;
  const shot = (kind: "chase" | "side", focus: 0 | 1): CameraShot => ({ key: `${kind}-${focus}`, label: `${driverName(focus)} · ${kind === "chase" ? "CHASE" : "TRACKSIDE"}`, kind, focus });
  if (t < 8) return shot("chase", 0);
  if (t < 15) return shot("side", 1);
  if (t < 22) {
    const a = safeAnchor(anchors[0]), b = safeAnchor(anchors[1]);
    if (Math.hypot(a.x - b.x, a.z - b.z) < 22 && Math.abs(a.y - b.y) < 4) return { key: "duel", label: "BATTLE CAM", kind: "duel" };
    return shot("side", finite(progress[0]) >= finite(progress[1]) ? 0 : 1);
  }
  if (t < 30) return shot("chase", 1);
  if (t < 37) return shot("side", 0);
  return { key: "overview", label: "CIRCUIT VIEW", kind: "overview" };
}

/** Real perspective, low camera positions and forward framing make track-side motion readable. */
export function cameraPose(shot: CameraShot, anchors: CameraAnchor[], aspect: number, seconds: number, moving: boolean, bounds = { width: 246, depth: 154 }): CameraPose {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const t = moving ? finite(seconds) : 0;
  const a = safeAnchor(anchors[0]), b = safeAnchor(anchors[1]);
  const portrait = Math.max(1, 1.15 / ratio);
  if (shot.kind === "overview") {
    const size = Math.max(bounds.width / Math.min(ratio, 1.65), bounds.depth) / 154;
    return { eye: [102 * size, 163 * size, 156 * size], target: [0, 0, 0], fov: 47 };
  }
  if (shot.kind === "duel" || shot.kind === "grid") {
    const x = (a.x + b.x) / 2, y = Math.max(a.y, b.y), z = (a.z + b.z) / 2;
    const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const extent = Math.max(1, gap / 10) * portrait;
    const dx = Math.cos(a.heading), dz = Math.sin(a.heading);
    return { eye: [x - dx * 12 * extent + dz * 9 * extent, y + 7 * extent, z - dz * 12 * extent - dx * 9 * extent], target: [x + dx * 1.5, y + 1, z + dz * 1.5], fov: 59 };
  }
  const p = shot.focus === 1 ? b : a;
  const dx = Math.cos(p.heading), dz = Math.sin(p.heading);
  // Bring the road markings into the foreground without advancing the race
  // clock. The lens responds only to the authoritative car speed, so a spin
  // or stop also loses its speed effect.
  const speedFov = moving ? Math.min(9, Math.max(0, p.speed) * 3) : 0;
  if (shot.kind === "chase") {
    const side = 2.7 + Math.sin(t * 0.25) * 0.35;
    return { eye: [p.x - dx * 9.8 * portrait + dz * side, p.y + 3.6 * portrait, p.z - dz * 9.8 * portrait - dx * side], target: [p.x + dx * 4.2, p.y + 1.05 + Math.sin(p.slope) * 4.2, p.z + dz * 4.2], fov: 59 + speedFov };
  }
  const front = 1.5 + Math.sin(t * 0.24) * 1.0;
  return { eye: [p.x + dx * front + dz * 10.2 * portrait, p.y + 3.6 * portrait, p.z + dz * front - dx * 10.2 * portrait], target: [p.x + dx * 2.1, p.y + 1, p.z + dz * 2.1], fov: 58 + speedFov };
}
