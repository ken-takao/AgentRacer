import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewerDriveDecision, sanitizeDriveDecision, sanitizeDriveDecisionFeed } from "../lib/drive-decision-feed.ts";

const decision = () => ({ model: "gpt-6-luna", count: 3, status: "decided", action: "lane_left",
  confidence: 0.82, obstacleRisk: 0.8, rivalRisk: 0.1, latencyMs: 280, observedAt: 1000, decidedAt: 1280 });

test("public decisions preserve bounded choices and discard private provider data", () => {
  const safe = sanitizeDriveDecision({ ...decision(), prompt: "private instruction", apiKey: "sk-secret", screenshot: "data:image/png;base64,secret" });
  assert.deepEqual(safe, decision());
  assert.equal(sanitizeDriveDecisionFeed({ red: safe, blue: null }).blue, null);
  assert.throws(() => sanitizeDriveDecisionFeed({ red: safe }));
});

test("failed or retried decisions cannot appear as a new chosen action or leak diagnostics", () => {
  for (const status of ["retry", "error"]) {
    const safe = sanitizeDriveDecision({ ...decision(), status, observedAt: null, error: "sk-secret provider diagnostics" });
    assert.equal(safe.action, null);
    assert.doesNotMatch(JSON.stringify(safe), /sk-secret|provider diagnostics/);
  }
});

test("invalid controls, numbers, model and observation timestamps are rejected", () => {
  for (const changes of [
    { action: "execute_secret_script" }, { action: null }, { count: -1 }, { count: 2.1 }, { model: "unexpected" },
    { confidence: 1.1 }, { rivalRisk: -1 }, { obstacleRisk: NaN }, { latencyMs: Infinity },
    { observedAt: null }, { observedAt: 1500 }, { decidedAt: 0 }, { status: "executed" },
  ]) assert.throws(() => sanitizeDriveDecision({ ...decision(), ...changes }), JSON.stringify(changes));
});

test("late uploads cannot replace newer choices or observations", () => {
  const previous = sanitizeDriveDecision(decision());
  const next = (changes: object) => sanitizeDriveDecision({ ...decision(), count: 4, observedAt: 1500, decidedAt: 1800, ...changes });
  assert.equal(isNewerDriveDecision(next({}), previous), true);
  assert.equal(isNewerDriveDecision(previous, previous), false);
  assert.equal(isNewerDriveDecision(next({ count: 2 }), previous), false);
  assert.equal(isNewerDriveDecision(next({ observedAt: 900 }), previous), false);
  assert.equal(isNewerDriveDecision(next({ observedAt: 1100, decidedAt: 1200 }), previous), false);
  assert.equal(isNewerDriveDecision(next({ status: "retry", count: 3, action: null, observedAt: null }), previous), true);
});
