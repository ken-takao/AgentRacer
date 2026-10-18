import { requestRaceJson } from './race-api.ts';

export type RaceArrivalState = {
  status: 'connecting' | 'waiting' | 'active' | 'offline' | 'failed' | 'error';
  raceId?: string;
  requestId?: string;
  message?: string;
  canRequest?: boolean;
  awaitingAvailability?: boolean;
};

function validLaunch(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as RaceArrivalState;
  return ['waiting', 'active', 'offline', 'failed'].includes(result.status)
    && (result.status !== 'active' || /^race_[a-f0-9]{32}$/.test(result.raceId ?? ''));
}

/** One request per page entry. Polling observes only; it never starts another race. */
export function observeRaceArrival(
  options: { previousRaceId?: string; onUpdate: (state: RaceArrivalState) => void; onReady: (id: string) => void },
  request: typeof requestRaceJson = requestRaceJson,
  interval = 2500,
): () => void {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arrived = false;
  let requested = false;
  async function poll() {
    try {
      let state = await request<RaceArrivalState>('/api/races/launch', { signal: abort.signal }, validLaunch);
      // An offline host can reconnect without another click. Once a request was
      // sent (even with an uncertain response), subsequent polls are GET only.
      if (!abort.signal.aborted && state.canRequest && !requested) {
        requested = true;
        state = await request<RaceArrivalState>('/api/races/launch', {
          signal: abort.signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previousRaceId: options.previousRaceId }),
        }, validLaunch);
      }
      if (abort.signal.aborted) return;
      if (state.status === 'waiting' || state.status === 'active') requested = true;
      options.onUpdate({ ...state, awaitingAvailability: !requested });
      if (state.status === 'active') {
        arrived = true;
        options.onReady(state.raceId!);
      }
    } catch (error) {
      if (!abort.signal.aborted) options.onUpdate({ status: 'error', awaitingAvailability: !requested, message: error instanceof Error ? error.message : '接続を確認しています。' });
    }
    if (!abort.signal.aborted && !arrived) timer = setTimeout(() => void poll(), interval);
  }
  void poll();
  return () => { abort.abort(); clearTimeout(timer); };
}
