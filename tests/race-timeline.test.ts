import assert from "node:assert/strict";
import { RaceTimeline } from "../lib/race-timeline.ts";

const snapshot = (updatedAt: number, phase = "racing", createdAt = 10) => ({
  phase, createdAt, updatedAt, marker: `snapshot-${updatedAt}`,
  players: {
    red: { progress: updatedAt / 100, lane: 0 },
    blue: { progress: updatedAt / 100 + 10, lane: 1 },
  },
});
type Snapshot = ReturnType<typeof snapshot>;
const position = (timeline: RaceTimeline<Snapshot>, now: number) => timeline.sample(now)!.players.red.progress;

// A regular 500 ms stream becomes uninterrupted animation after the initial
// buffer. Generic fields survive interpolation and the two cars share a clock.
const regular = new RaceTimeline<Snapshot>();
assert.equal(regular.sample(0), undefined);
regular.push(snapshot(0), 0);
for (let now = 0; now <= 4000; now += 20) {
  if (now && now % 500 === 0) regular.push(snapshot(now), now);
  const frame = regular.sample(now)!;
  assert.ok(frame.marker.startsWith("snapshot-"));
  assert.ok(Math.abs(frame.players.blue.progress - frame.players.red.progress - 10) < 1e-8);
  assert.ok(Math.abs(frame.players.red.progress - Math.max(0, now - 1000) / 100) < 1e-8,
    `regular playback at ${now} ms`);
}

// A jittery stream (including responses arriving in bursts) never resets the
// presentation clock. Once started, movement stays within the +/-10% slew.
const jitter = new RaceTimeline<Snapshot>();
const arrivals = [
  [0, 0], [500, 580], [1000, 1120], [1500, 1620], [2000, 2080],
  [2500, 2850], [3000, 3080], [3500, 3660], [4000, 4080], [4500, 4820],
] as const;
let arrival = 0, previous = 0;
for (let now = 0; now <= 4900; now += 20) {
  while (arrival < arrivals.length && arrivals[arrival][1] <= now) {
    const [server, received] = arrivals[arrival++];
    jitter.push(snapshot(server), received);
  }
  const current = position(jitter, now);
  assert.ok(current >= previous, `no rewind at ${now}`);
  if (now > 1120) assert.ok(current - previous >= 0.18 - 1e-8 && current - previous <= 0.22 + 1e-8,
    `continuous bounded speed at ${now}: ${current - previous}`);
  assert.ok(current <= arrivals[arrival - 1][0] / 100, "no prediction beyond newest position");
  previous = current;
}

// Late/duplicate responses cannot overwrite current data or revert the phase.
jitter.push(snapshot(1000, "lobby"), 5000);
jitter.push(snapshot(4500, "finished"), 5000);
assert.equal(jitter.sample(5000)!.phase, "racing");
assert.ok(position(jitter, 4990) >= previous, "non-monotonic local clock cannot rewind playback");

// When data stops, display the last authoritative position and wait for enough
// known trajectory before continuing. Longer interpolation intervals use time
// normalization, not the interpolation helper's historical one-second cap.
const stalled = new RaceTimeline<Snapshot>();
stalled.push(snapshot(0), 0);
stalled.push(snapshot(1000), 1000);
stalled.sample(1000);
for (let now = 1020; now <= 3500; now += 20) stalled.sample(now);
assert.equal(position(stalled, 3500), 10);
stalled.push(snapshot(2500), 3500);
assert.equal(position(stalled, 3500), 15, "recovery catches up forward to a full buffer");
const recovery = position(stalled, 3600);
assert.ok(recovery > 15 && recovery <= 16.1, "long segment advances by elapsed time, not a premature endpoint");

// A genuine disconnect discards the unknowable gap, snaps forward once, then
// buffers fresh snapshots. It does not animate through an absent trajectory.
stalled.push(snapshot(8000), 8000);
assert.equal(position(stalled, 8000), 80);
stalled.push(snapshot(8500), 8500);
assert.equal(position(stalled, 8500), 80);
stalled.push(snapshot(9000), 9000);
assert.equal(position(stalled, 9000), 80);
assert.ok(position(stalled, 9100) > 80);

// Terminal states, race replacement, and explicit reset bypass the buffer.
const finished = snapshot(9200, "finished");
stalled.push(finished, 9200);
assert.equal(stalled.sample(9200), finished);
const nextRace = snapshot(50, "lobby", 20);
stalled.push(nextRace, 9300);
assert.equal(stalled.sample(9300), nextRace);
const racing = snapshot(60, "racing", 20);
stalled.push(racing, 9400);
assert.equal(stalled.sample(9400), racing);
stalled.clear();
assert.equal(stalled.sample(9500), undefined);
assert.equal(stalled.bufferedSnapshotCount, 0);

// Background-tab polling has a hard memory bound even without animation frames.
const background = new RaceTimeline<Snapshot>();
for (let now = 0; now <= 100000; now += 500) background.push(snapshot(now), now);
assert.ok(background.bufferedSnapshotCount <= 64);
assert.equal(position(background, 100000), 990, "resume near the live buffer after a long hidden period");
assert.ok(position(background, 100100) > 990);

console.log("Race timeline: buffered cadence, network jitter, stale responses, stalls, reconnects, phases and bounded history passed");
