/** Public decisions contain choices and timing only, never prompts, frames, or credentials. */
export const DRIVE_ACTIONS = ["lane_left", "lane_center", "lane_right", "speed_slow", "speed_normal", "speed_turbo", "route_left", "route_right", "jump", "wait"] as const;
export type DriveAction = typeof DRIVE_ACTIONS[number];
export type DriveDecision = {
  model: "gpt-6-luna";
  count: number;
  status: "decided" | "retry" | "error";
  action: DriveAction | null;
  confidence: number | null;
  obstacleRisk: number | null;
  rivalRisk: number | null;
  latencyMs: number | null;
  observedAt: number | null;
  decidedAt: number;
  error?: string;
};
export type DriveDecisionFeed = { red: DriveDecision | null; blue: DriveDecision | null };

const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const optional = (value: unknown, max: number) => value === null || bounded(value, 0, max);

export function sanitizeDriveDecision(input: unknown): DriveDecision {
  const value = input as DriveDecision;
  if (!value || typeof value !== "object" || value.model !== "gpt-6-luna" ||
    !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 100000 ||
    !["decided", "retry", "error"].includes(value.status) ||
    (value.action !== null && !DRIVE_ACTIONS.includes(value.action)) ||
    !optional(value.confidence, 1) || !optional(value.obstacleRisk, 1) || !optional(value.rivalRisk, 1) ||
    !optional(value.latencyMs, 120000) || !bounded(value.decidedAt, 1, 8.64e15) ||
    !(value.observedAt === null || bounded(value.observedAt, 1, value.decidedAt)) ||
    (value.status === "decided" && (value.action === null || value.observedAt === null))) {
    throw new Error("Invalid drive decision");
  }
  return {
    model: "gpt-6-luna", count: value.count, status: value.status,
    action: value.status === "decided" ? value.action : null,
    confidence: value.confidence, obstacleRisk: value.obstacleRisk, rivalRisk: value.rivalRisk,
    latencyMs: value.latencyMs, observedAt: value.observedAt, decidedAt: value.decidedAt,
    ...(value.status === "error" ? { error: "判断APIへの接続を確認しています" } : {}),
  };
}

/** A delayed upload may never replace a newer decision or a newer observed frame. */
export function isNewerDriveDecision(next: DriveDecision, previous: DriveDecision) {
  return next.count >= previous.count && next.decidedAt > previous.decidedAt &&
    !(next.observedAt !== null && previous.observedAt !== null && next.observedAt < previous.observedAt);
}

export function sanitizeDriveDecisionFeed(input: unknown): DriveDecisionFeed {
  if (!input || typeof input !== "object") throw new Error("Invalid drive decision feed");
  const value = input as DriveDecisionFeed;
  return {
    red: value.red === null ? null : sanitizeDriveDecision(value.red),
    blue: value.blue === null ? null : sanitizeDriveDecision(value.blue),
  };
}
