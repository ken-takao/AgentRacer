import { interpolateRace } from "./race-presentation.ts";
import type { CourseFeatures, RouteChoice } from "./race-course.ts";

export type RaceTimelineSnapshot = {
  phase: string;
  createdAt: number;
  updatedAt: number;
  version?: number;
  course?: CourseFeatures;
  players: Record<"red" | "blue", {
    progress: number;
    lane: number;
    routeChoices?: Record<string, RouteChoice>;
  }>;
};

const BUFFER_MS = 1000;
const RECONNECT_MS = 3000;
const MAX_SNAPSHOTS = 64;

/**
 * Spectator-only playback of known server positions. A one-second delay absorbs
 * uneven polling without restarting interpolation whenever a response arrives.
 */
export class RaceTimeline<T extends RaceTimelineSnapshot> {
  private snapshots: T[] = [];
  private cursor: number | undefined;
  private sampledAt: number | undefined;
  private receivedAt = 0;
  private buffering = true;

  get bufferedSnapshotCount(): number { return this.snapshots.length; }

  clear(): void {
    this.snapshots = [];
    this.cursor = undefined;
    this.sampledAt = undefined;
    this.receivedAt = 0;
    this.buffering = true;
  }

  push(snapshot: T, receivedAtMs: number): void {
    if (!Number.isFinite(snapshot.updatedAt) || !Number.isFinite(receivedAtMs)) return;
    const newest = this.snapshots.at(-1);
    if (!newest || snapshot.createdAt !== newest.createdAt) {
      this.reset(snapshot, receivedAtMs);
      return;
    }
    // An old request completing late must not rewind either phase or position.
    if (snapshot.updatedAt <= newest.updatedAt) return;
    const receivedAt = Math.max(this.receivedAt, receivedAtMs);
    if (snapshot.phase !== newest.phase || snapshot.phase !== "racing"
      || receivedAt - this.receivedAt > RECONNECT_MS
      || snapshot.updatedAt - newest.updatedAt > RECONNECT_MS) {
      this.reset(snapshot, receivedAt);
      return;
    }
    this.snapshots.push(snapshot);
    this.receivedAt = receivedAt;
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.splice(0, this.snapshots.length - MAX_SNAPSHOTS);
      this.cursor = Math.max(this.cursor!, this.snapshots[0].updatedAt);
    }
  }

  sample(nowMs: number): T | undefined {
    const newest = this.snapshots.at(-1);
    if (!newest) return undefined;
    if (newest.phase !== "racing") return newest;
    if (!Number.isFinite(nowMs)) return this.frame();
    const now = Math.max(this.sampledAt ?? nowMs, nowMs);
    const elapsed = this.sampledAt === undefined ? 0 : now - this.sampledAt;
    this.sampledAt = now;

    if (elapsed > RECONNECT_MS) {
      // A background tab can miss many frames while polling continues. Resume
      // near the live buffer rather than replaying that entire hidden period.
      this.cursor = Math.max(this.cursor!, newest.updatedAt - BUFFER_MS);
      this.buffering = true;
    }
    if (this.buffering) {
      if (newest.updatedAt - this.cursor! >= BUFFER_MS) {
        this.cursor = Math.max(this.cursor!, newest.updatedAt - BUFFER_MS);
        this.buffering = false;
      }
      return this.frame();
    }

    // Estimate only the clock, never a car position. A small slew corrects
    // network-clock drift without arrival-dependent jumps in playback time.
    const sinceReceipt = Math.min(BUFFER_MS, Math.max(0, now - this.receivedAt));
    const target = newest.updatedAt + sinceReceipt - BUFFER_MS;
    const error = target - (this.cursor! + elapsed);
    const rate = Math.max(0.9, Math.min(1.1, 1 + error / 5000));
    this.cursor = Math.min(newest.updatedAt, this.cursor! + elapsed * rate);
    if (this.cursor >= newest.updatedAt) this.buffering = true;
    return this.frame();
  }

  private reset(snapshot: T, receivedAt: number): void {
    this.snapshots = [snapshot];
    this.cursor = snapshot.updatedAt;
    this.sampledAt = receivedAt;
    this.receivedAt = receivedAt;
    this.buffering = true;
  }

  private frame(): T {
    // Retain the two snapshots bracketing the presentation clock. In particular,
    // do not restart from the last network response on every animation frame.
    while (this.snapshots.length > 1 && this.snapshots[1].updatedAt <= this.cursor!) {
      this.snapshots.shift();
    }
    const previous = this.snapshots[0], current = this.snapshots[1];
    if (!current || this.cursor! <= previous.updatedAt) return previous;
    const duration = current.updatedAt - previous.updatedAt;
    const fraction = (this.cursor! - previous.updatedAt) / duration;
    // interpolateRace historically caps its duration at one second. Normalize
    // longer, valid intervals here so they still play at the correct speed.
    return interpolateRace(previous, current, fraction * Math.min(1000, duration));
  }
}
