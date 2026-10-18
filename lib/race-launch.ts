/** One public launch request, serviced by one authenticated local operator. */
export const LAUNCH_TIMING = { heartbeatMs: 20_000, leaseMs: 30_000, pendingMs: 120_000, cooldownMs: 30_000 } as const;
// Match the operator's bounded run lifetime so an abandoned lobby is not
// advertised as a joinable race until its longer storage TTL expires.
export const MAX_PREPARATION_MS = 8 * 60 * 1000;
export function isStalePreparation(state: { phase: string; createdAt: number }, now: number): boolean {
  return state.phase === 'lobby' && now - state.createdAt >= MAX_PREPARATION_MS;
}

export interface LaunchState {
  ownerId: string | null;
  heartbeatAt: number;
  accepting: boolean;
  status: 'idle' | 'pending' | 'starting' | 'active' | 'failed';
  requestId: string | null;
  requestedAt: number;
  leaseUntil: number;
  raceId: string | null;
}
export interface LaunchView {
  status: 'waiting' | 'active' | 'offline' | 'failed';
  canRequest: boolean;
  raceId?: string;
  requestId?: string;
  message?: string;
}
export type OperatorLaunchAction = {
  ownerId: string;
  action: 'heartbeat' | 'claim' | 'complete' | 'fail';
  accepting?: boolean;
  requestId?: string;
  raceId?: string;
};
export class LaunchConflict extends Error {}
export function emptyLaunchState(): LaunchState {
  return { ownerId: null, heartbeatAt: 0, accepting: false, status: 'idle', requestId: null, requestedAt: 0, leaseUntil: 0, raceId: null };
}
function online(state: LaunchState, now: number) { return !!state.ownerId && now - state.heartbeatAt < LAUNCH_TIMING.heartbeatMs; }
function expired(state: LaunchState, now: number) {
  return state.status === 'pending' ? now - state.requestedAt >= LAUNCH_TIMING.pendingMs : state.status === 'starting' && now >= state.leaseUntil;
}
function canRequestLaunch(state: LaunchState, now: number, activeRaceId: string | null) {
  return !activeRaceId && online(state, now) && state.accepting
    && (expired(state, now) || !['pending', 'starting'].includes(state.status))
    && (!state.requestId || now - state.requestedAt >= LAUNCH_TIMING.cooldownMs);
}
export function launchView(state: LaunchState, now: number, activeRaceId: string | null): LaunchView {
  if (activeRaceId) return { status: 'active', raceId: activeRaceId, canRequest: false };
  const request = { canRequest: canRequestLaunch(state, now, activeRaceId), ...(state.requestId ? { requestId: state.requestId } : {}) };
  if (state.status === 'failed' || expired(state, now)) return { status: 'failed', ...request, message: 'レースの準備を完了できませんでした。もう一度お試しください。' };
  if (!online(state, now)) return { status: 'offline', ...request, message: '主催者のオペレーターへの接続を待っています。接続後にもう一度お試しください。' };
  if (state.status === 'pending' || state.status === 'starting') return { status: 'waiting', ...request, message: '新しいレースを準備しています。' };
  if (!state.accepting) return { status: 'offline', ...request, message: '主催者が自動スタートを一時停止しています。' };
  return { status: 'offline', ...request, message: '次のレースを開始できます。' };
}

/** GET uses launchView only: polling can never enqueue a new paid run. */
export function requestLaunch(state: LaunchState, now: number, activeRaceId: string | null, newRequestId: string) {
  if (!canRequestLaunch(state, now, activeRaceId)) return state;
  return { ...state, status: 'pending' as const, requestId: newRequestId, requestedAt: now, leaseUntil: 0, raceId: null };
}

export function operatorLaunch(state: LaunchState, input: OperatorLaunchAction, now: number, activeRaceId: string | null): { state: LaunchState; claimedRequestId: string | null } {
  // An expired starting lease is never reclaimed: the previous process may have
  // made an external API call before losing its connection.
  let next = expired(state, now) ? { ...state, status: 'failed' as const } : { ...state };
  const owned = state.ownerId === input.ownerId;
  if (!owned && (online(state, now) || (state.status === 'starting' && now < state.leaseUntil))) throw new LaunchConflict('Another operator is connected');
  if (input.action === 'complete' || input.action === 'fail') {
    if (!owned || !input.requestId || input.requestId !== state.requestId || !['starting', 'active'].includes(next.status)) throw new LaunchConflict('Launch claim is no longer valid');
    if (input.action === 'complete' && !input.raceId) throw new LaunchConflict('Race ID is required');
    next.status = input.action === 'complete' ? 'active' : 'failed';
    next.raceId = input.action === 'complete' ? input.raceId! : null;
    next.leaseUntil = 0;
  }
  next.ownerId = input.ownerId;
  next.heartbeatAt = now;
  if (input.accepting !== undefined) next.accepting = input.accepting;
  else if (!owned) next.accepting = true;
  if (next.status === 'starting') next.leaseUntil = now + LAUNCH_TIMING.leaseMs;
  let claimedRequestId: string | null = null;
  if (activeRaceId && next.status === 'pending') {
    next.status = 'active'; next.raceId = activeRaceId;
  } else if (input.action === 'claim' && next.accepting && next.status === 'pending') {
    next.status = 'starting'; next.leaseUntil = now + LAUNCH_TIMING.leaseMs; claimedRequestId = next.requestId;
  } else if (!next.accepting && next.status === 'pending') {
    // Stopping the operator also discards old demand. Resuming alone cannot run it.
    next.status = 'failed';
  }
  return { state: next, claimedRequestId };
}
