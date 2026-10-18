import assert from "node:assert/strict";
import test from "node:test";
import { RaceSoundMixer, type SoundController } from "../lib/race-sound.ts";

function player() {
  const calls: (readonly ["enabled", boolean] | readonly ["volume", number])[] = [];
  const controller: SoundController = {
    setEnabled: enabled => { calls.push(["enabled", enabled]); },
    setVolume: volume => { calls.push(["volume", volume]); },
  };
  return { calls, controller };
}

test("a new viewer gets both channels enabled at audible default volumes", () => {
  const mixer = new RaceSoundMixer();
  assert.deepEqual(mixer.getSnapshot(), {
    bgm: { enabled: true, volume: 45, status: "ready" },
    narration: { enabled: true, volume: 90, status: "ready" },
  });
});

test("players receive the chosen volume before attempting playback on registration", () => {
  const mixer = new RaceSoundMixer();
  const bgm = player(), narration = player();
  mixer.register("bgm", bgm.controller);
  assert.deepEqual(bgm.calls, [["volume", 45], ["enabled", true]]);

  // Preferences may be changed before an asynchronously mounted player is ready.
  mixer.setVolume("narration", 35);
  mixer.toggle("narration");
  mixer.register("narration", narration.controller);
  assert.deepEqual(narration.calls, [["volume", 35], ["enabled", false]]);
});

test("muting either channel leaves the other alone and preserves its chosen volume", () => {
  const mixer = new RaceSoundMixer();
  const bgm = player(), narration = player();
  mixer.register("bgm", bgm.controller);
  mixer.register("narration", narration.controller);
  bgm.calls.length = narration.calls.length = 0;
  mixer.setVolume("bgm", 20);
  mixer.toggle("bgm");
  assert.equal(mixer.getSnapshot().bgm.enabled, false);
  assert.equal(mixer.getSnapshot().narration.enabled, true);
  assert.deepEqual(narration.calls, []);

  mixer.toggle("narration");
  mixer.setVolume("bgm", 30);
  mixer.toggle("bgm");
  assert.deepEqual(mixer.getSnapshot().bgm, { enabled: true, volume: 30, status: "ready" });
  assert.equal(mixer.getSnapshot().narration.enabled, false);
  assert.equal(mixer.getSnapshot().narration.volume, 90);
  assert.deepEqual(bgm.calls, [["volume", 20], ["enabled", false], ["volume", 30], ["enabled", true]]);
  assert.deepEqual(narration.calls, [["enabled", false]]);
});

test("autoplay rejection reports a playback state without changing the viewer preference", () => {
  const mixer = new RaceSoundMixer();
  const bgm = player();
  mixer.register("bgm", bgm.controller);
  bgm.calls.length = 0;
  mixer.reportStatus("bgm", "blocked");
  assert.deepEqual(mixer.getSnapshot().bgm, { enabled: true, volume: 45, status: "blocked" });
  assert.deepEqual(bgm.calls, []);
  mixer.toggle("bgm");
  mixer.reportStatus("bgm", "unavailable");
  assert.equal(mixer.getSnapshot().bgm.enabled, false, "late playback status must not unmute a channel");
});

test("a resume gesture invokes both enabled players synchronously and never revives a muted one", () => {
  const mixer = new RaceSoundMixer();
  const resumed: string[] = [];
  let inGesture = false;
  for (const channel of ["bgm", "narration"] as const) {
    mixer.register(channel, {
      setVolume() {},
      setEnabled(enabled) {
        if (enabled) resumed.push(`${channel}:${inGesture}`);
      },
    });
    mixer.reportStatus(channel, "blocked");
  }
  resumed.length = 0;
  inGesture = true;
  mixer.resumeEnabled();
  inGesture = false;
  assert.deepEqual(resumed, ["bgm:true", "narration:true"]);

  mixer.toggle("bgm");
  resumed.length = 0;
  inGesture = true;
  mixer.resumeEnabled();
  inGesture = false;
  assert.deepEqual(resumed, ["narration:true"]);
  assert.equal(mixer.getSnapshot().bgm.enabled, false);
});

test("cleanup of an old player cannot unregister its replacement", () => {
  const mixer = new RaceSoundMixer();
  const oldPlayer = player(), replacement = player();
  const removeOld = mixer.register("bgm", oldPlayer.controller);
  const removeReplacement = mixer.register("bgm", replacement.controller);
  oldPlayer.calls.length = replacement.calls.length = 0;
  removeOld();
  mixer.setVolume("bgm", 60);
  mixer.toggle("bgm");
  assert.deepEqual(oldPlayer.calls, []);
  assert.deepEqual(replacement.calls, [["volume", 60], ["enabled", false]]);

  removeReplacement();
  replacement.calls.length = 0;
  mixer.toggle("bgm");
  mixer.resumeEnabled();
  assert.deepEqual(replacement.calls, [], "unmounted players are never called again");
});

test("volume remains in the supported range and invalid inputs leave playback unchanged", () => {
  const mixer = new RaceSoundMixer();
  const bgm = player();
  mixer.register("bgm", bgm.controller);
  bgm.calls.length = 0;
  mixer.setVolume("bgm", -10);
  assert.equal(mixer.getSnapshot().bgm.volume, 0);
  mixer.setVolume("bgm", 150);
  assert.equal(mixer.getSnapshot().bgm.volume, 100);
  const beforeInvalid = mixer.getSnapshot();
  for (const value of [NaN, Infinity, -Infinity]) mixer.setVolume("bgm", value);
  assert.equal(mixer.getSnapshot(), beforeInvalid);
  assert.deepEqual(bgm.calls, [["volume", 0], ["volume", 100]]);
});

test("subscribers see fresh snapshots while previous snapshots and unsubscribed listeners stay unchanged", () => {
  const mixer = new RaceSoundMixer();
  const original = mixer.getSnapshot();
  const snapshots: ReturnType<RaceSoundMixer["getSnapshot"]>[] = [];
  const unsubscribe = mixer.subscribe(() => snapshots.push(mixer.getSnapshot()));
  mixer.toggle("bgm");
  assert.equal(snapshots.length, 1);
  assert.notEqual(snapshots[0], original);
  assert.equal(original.bgm.enabled, true);
  assert.equal(snapshots[0].bgm.enabled, false);
  unsubscribe();
  mixer.toggle("bgm");
  assert.equal(snapshots.length, 1);
});
