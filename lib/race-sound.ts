export type SoundChannel = "bgm" | "narration";
export type SoundStatus = "ready" | "playing" | "blocked" | "unavailable";
export type SoundController = { setEnabled(enabled: boolean): void; setVolume(volume: number): void };
type ChannelState = { enabled: boolean; volume: number; status: SoundStatus };
type SoundSnapshot = Record<SoundChannel, ChannelState>;

/** Viewer preferences are independent of autoplay permission and playback state. */
export class RaceSoundMixer {
  private snapshot: SoundSnapshot = {
    bgm: { enabled: true, volume: 45, status: "ready" },
    narration: { enabled: true, volume: 90, status: "ready" },
  };
  private controllers = new Map<SoundChannel, SoundController>();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(channel: SoundChannel, change: Partial<ChannelState>) {
    this.snapshot = { ...this.snapshot, [channel]: { ...this.snapshot[channel], ...change } };
    this.listeners.forEach(listener => listener());
  }
  register(channel: SoundChannel, controller: SoundController) {
    this.controllers.set(channel, controller);
    const state = this.snapshot[channel];
    controller.setVolume(state.volume);
    controller.setEnabled(state.enabled);
    return () => { if (this.controllers.get(channel) === controller) this.controllers.delete(channel); };
  }
  reportStatus(channel: SoundChannel, status: SoundStatus) {
    if (this.snapshot[channel].status !== status) this.update(channel, { status });
  }
  toggle(channel: SoundChannel) {
    const enabled = !this.snapshot[channel].enabled;
    this.update(channel, { enabled });
    // Keep play()/AudioContext.resume() in the original user gesture.
    this.controllers.get(channel)?.setEnabled(enabled);
  }
  setVolume(channel: SoundChannel, value: number) {
    if (!Number.isFinite(value)) return;
    const volume = Math.max(0, Math.min(100, value));
    this.update(channel, { volume });
    this.controllers.get(channel)?.setVolume(volume);
  }
  resumeEnabled() {
    // Do not await one player before resuming the other, or revive a muted channel.
    for (const channel of ["bgm", "narration"] as const) {
      if (this.snapshot[channel].enabled) this.controllers.get(channel)?.setEnabled(true);
    }
  }
}
