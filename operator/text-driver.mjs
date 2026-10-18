import { decideDrive } from './drive-decisions.mjs';
import { createDriveObservation, driveActionStatus, DECISION_MAX_AGE_MS, OBSERVATION_MAX_AGE_MS } from './drive-observation.mjs';

const PAUSE_MS = 750;
const TERMINAL = new Set(['finished', 'cancelled']);
const API_CODES = new Set(['api_error', 'timeout', 'refused', 'invalid_response', 'missing_key', 'invalid_player', 'invalid_observation']);
class TextDriverError extends Error {
  constructor(code, message) { super(message); this.name = 'TextDriverError'; this.code = code; }
}
const failure = (code, message) => new TextDriverError(code, message);
const aborted = () => failure('aborted', 'Text driving was cancelled.');

/** Also stops awaiting injected functions that do not implement cancellation. */
function cancellable(operation, signal) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw aborted();
      return operation();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function pause(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * One observation, one decision and at most one visible CU action at a time.
 * execute must enforce its own CU/ack deadline and cancel its in-flight work on
 * signal. An ambiguous/failed action is never retried by this driver.
 * All callbacks receive allowlisted observations or timing-only trace records;
 * raw server state, credentials and underlying error messages stay private.
 */
export async function runTextDriver({ color, key, signal, readState, execute, decide = decideDrive,
  onDecision = () => {}, onTrace = () => {}, onError = () => {}, now = Date.now, sleep = pause }) {
  if (!['red', 'blue'].includes(color) || typeof key !== 'string' || !key.trim()
      || [readState, execute, decide, onDecision, onTrace, onError, now, sleep].some(fn => typeof fn !== 'function')) {
    throw failure('invalid_configuration', 'Text driving requires an assigned driver and valid callbacks.');
  }
  let iterations = 0, executed = 0, failures = 0;
  const result = reason => ({ reason, iterations, executed });
  const call = operation => cancellable(operation, signal);
  const elapsed = (start, end = now()) => Math.max(0, end - start);
  const fresh = (observation, maxAge) => {
    const age = now() - observation.observedAt;
    return Number.isFinite(age) && age >= -1000 && age <= maxAge;
  };
  const emit = trace => call(() => onTrace(Object.freeze({ ...trace })));
  const skip = async (trace, reason) => {
    await emit({ ...trace, completedAt: now(), totalMs: elapsed(trace.observedAt), skipReason: reason });
    await call(() => sleep(PAUSE_MS, { signal }));
  };
  const observe = async () => {
    let capture;
    try { capture = await call(() => readState({ signal })); }
    catch (error) {
      if (signal?.aborted || error?.code === 'aborted') throw aborted();
      throw failure('state_read_failed', 'Could not read the current race state.');
    }
    try { return createDriveObservation({ state: capture?.state, observedAt: capture?.observedAt, color }); }
    catch { throw failure('invalid_observation', 'The current race observation is invalid.'); }
  };
  try {
    while (!signal?.aborted) {
      const observation = await observe();
      if (TERMINAL.has(observation.phase)) return result('terminal');
      const trace = { observedAt: observation.observedAt, readCompletedAt: now(), readMs: elapsed(observation.observedAt) };
      if (!fresh(observation, OBSERVATION_MAX_AGE_MS)) { await skip(trace, 'expired'); continue; }
      let decision;
      const decisionStartedAt = now();
      trace.decisionStartedAt = decisionStartedAt;
      iterations++;
      try { decision = await call(() => decide({ key, color, observation, signal, now })); }
      catch (error) {
        if (signal?.aborted || error?.code === 'aborted') return result('aborted');
        trace.decisionMs = elapsed(decisionStartedAt);
        if (error?.code === 'stale_observation') { await skip(trace, 'expired'); continue; }
        failures++;
        const code = API_CODES.has(error?.code) ? error.code : 'api_error';
        await call(() => onError(Object.freeze({ code, consecutiveFailures: failures, at: now() })));
        await emit({ ...trace, completedAt: now(), totalMs: elapsed(observation.observedAt), skipReason: code });
        if (failures >= 3) throw failure('decision_failed', 'Three consecutive driving decisions failed.');
        await call(() => sleep(PAUSE_MS, { signal }));
        continue;
      }
      failures = 0;
      trace.decidedAt = now();
      trace.decisionMs = elapsed(decisionStartedAt, trace.decidedAt);
      await call(() => onDecision(decision, Object.freeze({ ...trace })));
      if (decision?.action === 'wait') { await skip(trace, 'wait'); continue; }
      if (!fresh(observation, DECISION_MAX_AGE_MS)) { await skip(trace, 'expired'); continue; }
      const originalStatus = driveActionStatus(decision?.action, observation);
      if (!originalStatus.valid) { await skip(trace, originalStatus.reason); continue; }

      const revalidationStartedAt = now();
      const current = await observe();
      trace.revalidatedAt = now();
      trace.revalidateMs = elapsed(revalidationStartedAt, trace.revalidatedAt);
      if (TERMINAL.has(current.phase)) {
        await emit({ ...trace, completedAt: now(), totalMs: elapsed(observation.observedAt), skipReason: 'race_finished' });
        return result('terminal');
      }
      if (!fresh(observation, DECISION_MAX_AGE_MS) || !fresh(current, OBSERVATION_MAX_AGE_MS)) { await skip(trace, 'expired'); continue; }
      if (current.stateAt < observation.stateAt) { await skip(trace, 'stale_state'); continue; }
      const status = driveActionStatus(decision?.action, current);
      if (!status.valid) { await skip(trace, status.reason); continue; }
      // A route decision belongs to the observed fork, never the next fork.
      if (originalStatus.input?.type === 'route' && status.input?.junctionId !== originalStatus.input.junctionId) {
        await skip(trace, 'route_changed'); continue;
      }
      trace.dispatchedAt = now();
      trace.dispatchAgeMs = elapsed(observation.observedAt, trace.dispatchedAt);
      try {
        await call(() => execute({ decision, input: status.input, observation: current, trace: Object.freeze({ ...trace }), signal }));
      } catch (error) {
        if (signal?.aborted || error?.code === 'aborted') return result('aborted');
        await emit({ ...trace, completedAt: now(), executeMs: elapsed(trace.dispatchedAt), totalMs: elapsed(observation.observedAt),
          skipReason: error?.code === 'timeout' ? 'execution_timeout' : 'execution_failed' });
        throw failure('execution_failed', 'The visible driving action failed or was not acknowledged. It was not retried.');
      }
      executed++;
      await emit({ ...trace, completedAt: now(), executeMs: elapsed(trace.dispatchedAt), totalMs: elapsed(observation.observedAt) });
    }
    return result('aborted');
  } catch (error) {
    if (signal?.aborted || error?.code === 'aborted') return result('aborted');
    // Deliberately discard callback errors: they can include transport details.
    if (error instanceof TextDriverError) throw error;
    throw failure('driver_failed', 'Text driving stopped because a driver callback failed.');
  }
}
