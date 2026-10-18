/** Spectator-only coordinates: the server's race distance is never changed here. */
export const CIRCUIT_3D = { straight: 56, radius: 21, laneWidth: 4.2, halfWidth: 6.3 } as const;
const { straight, radius, laneWidth } = CIRCUIT_3D;
export const CIRCUIT_LAP_DISTANCE = 2 * straight + 2 * Math.PI * radius;

/** All lanes share the same progress fraction, so one server gate spans one course section. */
export function circuitPosition(progress: number, lane: number, courseLength: number) {
  const safeLength = courseLength > 0 && Number.isFinite(courseLength) ? courseLength : 200;
  const fraction = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress / safeLength : 0));
  const offset = (Math.max(0, Math.min(2, lane)) - 1) * laneWidth;
  return circuitAtDistance(fraction * CIRCUIT_LAP_DISTANCE + straight / 2, offset);
}

/** Offset is positive toward the outside of the oval. Start line is the near straight's centre. */
export function circuitAtDistance(distance: number, offset = 0) {
  const d = ((distance % CIRCUIT_LAP_DISTANCE) + CIRCUIT_LAP_DISTANCE) % CIRCUIT_LAP_DISTANCE;
  const r = radius + offset;
  if (d < straight) return { x: -straight / 2 + d, z: r, heading: 0 };
  if (d < straight + Math.PI * radius) {
    const angle = Math.PI / 2 - (d - straight) / radius;
    return { x: straight / 2 + Math.cos(angle) * r, z: Math.sin(angle) * r, heading: angle - Math.PI / 2 };
  }
  if (d < 2 * straight + Math.PI * radius) return { x: straight / 2 - (d - straight - Math.PI * radius), z: -r, heading: Math.PI };
  const angle = -Math.PI / 2 - (d - 2 * straight - Math.PI * radius) / radius;
  return { x: -straight / 2 + Math.cos(angle) * r, z: Math.sin(angle) * r, heading: angle - Math.PI / 2 };
}

/** Choose opposite lateral render offsets that preserve the current inside/outside order. */
export function circuitBodyOffsets(red: { x: number; z: number; heading: number }, blue: { x: number; z: number; heading: number }): [number, number] {
  if (Math.hypot(red.x - blue.x, red.z - blue.z) >= 3.1) return [0, 0];
  const lateralDelta = (red.x - blue.x) * -Math.sin(red.heading) + (red.z - blue.z) * Math.cos(red.heading);
  const redSide = lateralDelta > 1e-7 ? 1 : -1;
  return [redSide * 1.45, -redSide * 1.45];
}
