export type CameraAnchor = { x: number; z: number; heading: number };
export type CameraShot = {
  key: string;
  label: string;
  kind: "overview" | "chase" | "side" | "duel" | "grid";
  focus?: 0 | 1;
};
export type CameraPose = { eye: [number, number, number]; target: [number, number, number]; height: number };

const driverName = (focus: 0 | 1) => focus === 0 ? "SCARLET" : "COBALT";
const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? value as number : fallback;
const safeAnchor = (anchor?: CameraAnchor): CameraAnchor => ({ x: finite(anchor?.x), z: finite(anchor?.z), heading: finite(anchor?.heading) });

/** The caller advances the slot only after the current shot's minimum dwell time. */
export function selectAutoShot(phase: string, slot: number, anchors: CameraAnchor[], progress: number[]): CameraShot {
  if (phase === "countdown") return { key: "grid", label: "STARTING GRID", kind: "grid" };
  if (phase !== "racing") return { key: phase === "lobby" ? "waiting" : "overview", label: phase === "lobby" ? "GRID FORMING" : "CIRCUIT VIEW", kind: "overview" };
  const step = ((Math.floor(finite(slot)) % 6) + 6) % 6;
  if (step === 0) return { key: "overview", label: "CIRCUIT VIEW", kind: "overview" };
  const shot = (kind: "chase" | "side", focus: 0 | 1): CameraShot => ({ key: `${kind}-${focus}`, label: `${driverName(focus)} · ${kind === "chase" ? "CHASE" : "TRACKSIDE"}`, kind, focus });
  if (step === 1) return shot("chase", 0);
  if (step === 2) return shot("side", 1);
  if (step === 3) {
    const a = safeAnchor(anchors[0]), b = safeAnchor(anchors[1]);
    if (Math.hypot(a.x - b.x, a.z - b.z) < 36) return { key: "duel", label: "BATTLE CAM", kind: "duel" };
    return shot("side", finite(progress[0]) >= finite(progress[1]) ? 0 : 1);
  }
  return step === 4 ? shot("chase", 1) : shot("side", 0);
}

/** Camera-only presentation; never advances or changes either driver's position. */
export function cameraPose(shot: CameraShot, anchors: CameraAnchor[], aspect: number, seconds: number, moving: boolean): CameraPose {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const t = moving ? finite(seconds) : 0;
  const a = safeAnchor(anchors[0]), b = safeAnchor(anchors[1]);
  if (shot.kind === "overview") {
    const angle = Math.atan2(116, 84) + Math.sin(t * 0.13) * 0.045;
    const radius = Math.hypot(84, 116);
    return { eye: [Math.cos(angle) * radius, 100 + Math.sin(t * 0.11) * 1.5, Math.sin(angle) * radius], target: [0, 0, -1], height: Math.max(89, 146 / ratio) };
  }
  if (shot.kind === "duel" || shot.kind === "grid") {
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
    const gap = Math.hypot(a.x - b.x, a.z - b.z);
    // A gap-sized square contains both cars for every heading and viewport aspect.
    const extent = Math.max(shot.kind === "grid" ? 38 : 34, gap + 18);
    const sway = shot.kind === "duel" ? Math.sin(t * 0.22) * 3 : 0;
    return { eye: [x - 24 + sway, shot.kind === "grid" ? 26 : 36, z + 31], target: [x, 0.8, z], height: Math.max(extent, extent / ratio) };
  }
  const p = shot.focus === 1 ? b : a;
  const dx = Math.cos(p.heading), dz = Math.sin(p.heading);
  if (shot.kind === "chase") {
    const side = 11 + Math.sin(t * 0.3) * 1.2;
    return { eye: [p.x - dx * 17 + dz * side, 20.5 + Math.sin(t * 0.24) * 0.5, p.z - dz * 17 - dx * side], target: [p.x + dx * 5, 0.8, p.z + dz * 5], height: Math.max(29, 43 / ratio) };
  }
  const front = 7 + Math.sin(t * 0.27) * 3;
  const side = 23 + Math.sin(t * 0.17) * 2;
  return { eye: [p.x + dx * front + dz * side, 23 + Math.sin(t * 0.21), p.z + dz * front - dx * side], target: [p.x + dx * 2, 0.8, p.z + dz * 2], height: Math.max(30, 44 / ratio) };
}
