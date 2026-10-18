import assert from "node:assert/strict";
import { test } from "node:test";
import { isNarrationWav, sanitizeNarrationFeed } from "../lib/narration-feed.ts";

const id = "race_01234567890123456789012345678901";
const feed = () => ({ version: 1, raceId: id, generationId: "generation-one", status: "live",
  voice: "marin", sampleRate: 24000, startedAt: 1000, updatedAt: 2000,
  chunks: [{ seq: 0, url: "https://untrusted.invalid/track", startMs: 0, durationMs: 1000 }],
  captions: [{ id: "c1", text: "スタート！", startMs: 20, endMs: 900 }], privateKey: "secret" });

test("public feed allowlists fields and forces audio URLs onto the race origin", () => {
  const result = sanitizeNarrationFeed(feed(), id);
  assert.equal(result.chunks[0].url, `/api/races/${id}/narration/audio/generation-one/0`);
  assert.ok(!("privateKey" in result));
  assert.equal(result.captions[0].text, "スタート！");
});

test("reject cross-race feeds, unsafe paths and overlapping/out-of-order audio", () => {
  assert.throws(() => sanitizeNarrationFeed(feed(), "another-race"));
  assert.throws(() => sanitizeNarrationFeed({ ...feed(), generationId: "../../bad" }, id));
  assert.throws(() => sanitizeNarrationFeed({ ...feed(), chunks: [...feed().chunks, { seq: 1, startMs: 500, durationMs: 1000 }] }, id));
  assert.throws(() => sanitizeNarrationFeed({ ...feed(), chunks: [...feed().chunks, ...feed().chunks] }, id));
  assert.throws(() => sanitizeNarrationFeed({ ...feed(), captions: [{ ...feed().captions[0], endMs: -1 }] }, id));
});

test("error feeds never forward provider diagnostics or credentials", () => {
  const result = sanitizeNarrationFeed({ ...feed(), status: "error", error: "sk-secret provider diagnostics" }, id);
  assert.doesNotMatch(result.error!, /sk-secret|provider/);
});

test("only canonical short mono 24k PCM WAV is accepted", () => {
  const b = new ArrayBuffer(48044); const v = new DataView(b); const u = new Uint8Array(b);
  const text = (at: number, s: string) => [...s].forEach((c, i) => { u[at+i] = c.charCodeAt(0); });
  text(0, "RIFF"); text(8, "WAVE"); text(12, "fmt "); text(36, "data");
  v.setUint32(4, b.byteLength - 8, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); v.setUint32(40, b.byteLength - 44, true);
  assert.equal(isNarrationWav(b), true);
  v.setUint32(24, 48000, true); assert.equal(isNarrationWav(b), false);
  assert.equal(isNarrationWav(new TextEncoder().encode("<!DOCTYPE html>not audio").buffer), false);
});
