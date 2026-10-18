import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_TOOL, decideDrive } from './drive-decisions.mjs';

const frame = { id: 'cu-frame-1', imageUrl: 'data:image/png;base64,aGVsbG8=', at: 10000 };
const input = { key: 'test-key-never-display', color: 'red', frame, now: () => 10000 };
const answers = (action = 'lane_left') => ({ answers: [
  { type: 'predicate', name: 'rival_risk', probability: 0.2 },
  { type: 'choice', name: 'action', choice: action, confidence: 0.9, probabilities: [] },
  { type: 'predicate', name: 'obstacle_risk', probability: 0.8 },
] });
const response = body => ({ ok: true, status: 200, json: async () => body });
const failsWith = code => error => error.code === code && !String(error).includes(input.key);

test('uses the actual screenshot and typed Decisions questions, not hidden game data or generated prose', async () => {
  let clock = 10000;
  const result = await decideDrive({ ...input, now: () => clock, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${input.key}`);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions']);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.input.length, 1);
    assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: frame.imageUrl });
    assert.match(body.input[0].content[0].text, /SCARLET, the RED car/);
    assert.match(body.input[0].content[0].text, /opponent is COBALT/);
    assert.deepEqual(body.questions.map(q => [q.name, q.type]), [['action', 'choice'], ['obstacle_risk', 'predicate'], ['rival_risk', 'predicate']]);
    assert.equal(body.questions[0].choices.length, 9);
    clock += 450;
    return response(answers());
  } });
  assert.deepEqual(result, { action: 'lane_left', instruction: 'Click LEFT once in 02 / CHOOSE YOUR LANE.', confidence: 0.9, obstacleRisk: 0.8, rivalRisk: 0.2, latencyMs: 450, observedAt: 10000, decidedAt: 10450, model: 'gpt-6-luna' });
  assert.equal(DECISION_TOOL.name, 'decide_drive');
  assert.equal(DECISION_TOOL.parameters.additionalProperties, false);
  assert.deepEqual(DECISION_TOOL.parameters.properties, {});
});

test('blue driver receives its own identity and route clicks are distinct from lane clicks', async () => {
  const result = await decideDrive({ ...input, color: 'blue', fetchImpl: async (_, init) => {
    assert.match(JSON.parse(init.body).input[0].content[0].text, /driving COBALT, the BLUE car/);
    return response(answers('route_right'));
  } });
  assert.match(result.instruction, /RIGHT branch.*ROUTE.*not the lane/);
});

test('rejects absent, stale, future and remote screenshots before sending a request', async () => {
  for (const [candidate, code] of [[null, 'invalid_frame'], [{ ...frame, at: -2001 }, 'stale_frame'], [{ ...frame, at: 11001 }, 'stale_frame'], [{ ...frame, imageUrl: 'https://example.com/screenshot.png' }, 'invalid_frame']]) {
    await assert.rejects(decideDrive({ ...input, frame: candidate, fetchImpl: () => { assert.fail('must not send'); } }), failsWith(code));
  }
});

test('rejects a decision whose screenshot expires while the API is responding', async () => {
  let clock = 21000;
  await assert.rejects(decideDrive({ ...input, now: () => clock, fetchImpl: async () => { clock = 22001; return response(answers()); } }), failsWith('stale_frame'));
});

test('accepts the boundary freshness and returns an explicit no-control-change wait', async () => {
  const result = await decideDrive({ ...input, now: () => 22000, fetchImpl: async () => response(answers('wait')) });
  assert.equal(result.action, 'wait');
  assert.match(result.instruction, /^Do not change any driving control/);
});

test('rejects refusal, unknown actions, duplicate answers and invalid probabilities', async () => {
  const refusal = answers(); refusal.answers[1] = { type: 'refusal', name: 'action', reason: input.key };
  const duplicate = answers(); duplicate.answers[0] = duplicate.answers[1];
  const nan = answers(); nan.answers[0].probability = NaN;
  const over = answers(); over.answers[1].confidence = 1.001;
  const missing = answers(); missing.answers.pop();
  for (const [body, code] of [[refusal, 'refused'], [answers('__proto__'), 'invalid_response'], [answers(['lane_left']), 'invalid_response'], [answers(input.key), 'invalid_response'], [duplicate, 'invalid_response'], [nan, 'invalid_response'], [over, 'invalid_response'], [missing, 'invalid_response']]) {
    await assert.rejects(decideDrive({ ...input, fetchImpl: async () => response(body) }), failsWith(code));
  }
});

test('never exposes provider error bodies, malformed JSON, or thrown network secrets', async () => {
  const cases = [
    async () => ({ ok: false, status: 401, json: async () => { assert.fail('error body must not be read'); } }),
    async () => ({ ok: true, json: async () => { throw new Error(`Unexpected token < at ${input.key}`); } }),
    async () => { throw new Error(`connect ${input.key}`); },
  ];
  for (const fetchImpl of cases) await assert.rejects(decideDrive({ ...input, fetchImpl }), failsWith('api_error'));
});

test('aborts before request and in flight without exposing the caller abort reason', async () => {
  const pre = new AbortController(); pre.abort(input.key);
  await assert.rejects(decideDrive({ ...input, signal: pre.signal, fetchImpl: () => { assert.fail('must not send'); } }), failsWith('aborted'));
  const running = new AbortController();
  let requestSignal;
  const result = decideDrive({ ...input, signal: running.signal, fetchImpl: async (_, options) => {
    requestSignal = options.signal;
    running.abort(input.key);
    return new Promise(() => {});
  } });
  await assert.rejects(result, failsWith('aborted'));
  assert.equal(requestSignal.aborted, true);
});

test('an eight-second deadline aborts even a fetch implementation that does not settle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const result = decideDrive({ ...input, fetchImpl: async (_, options) => { requestSignal = options.signal; return new Promise(() => {}); } });
  const rejected = assert.rejects(result, failsWith('timeout'));
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});
