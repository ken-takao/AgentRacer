import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createOperatorServer, parseEnv, readEventStream, drivingInputs } from './server.mjs';
import { loadObstacleCatalog, parsePlacement, placementView } from './obstacles.mjs';

test('env parser preserves quoted values and ignores comments', () => {
  assert.deepEqual(parseEnv('A=one # comment\nB="two three"\nexport C=42\n# D=no'), { A: 'one', B: 'two three', C: '42' });
});

test('driving evidence excludes joins and READY actions', () => {
  assert.deepEqual(drivingInputs({ history: [
    { type: 'joined', playerId: 'red' }, { type: 'ready', playerId: 'red' },
    { type: 'lane_change', playerId: 'red' }, { type: 'speed_change', playerId: 'red' },
    { type: 'speed_change', playerId: 'blue' }, { type: 'collision', playerId: 'blue' },
  ] }), { red: 2, blue: 1 });
});

test('route choices count as driving evidence, contacts do not', () => {
  assert.deepEqual(drivingInputs({ history: [
    { type: 'route_change', playerId: 'red' }, { type: 'car_collision' },
    { type: 'route_entered', playerId: 'blue' },
  ] }), { red: 1, blue: 0 });
});

test('accepted jumps count as driving evidence but landings and rejected jumps do not', () => {
  assert.deepEqual(drivingInputs({ history: [
    { type: 'jump_started', playerId: 'red' }, { type: 'jump_landed', playerId: 'red' },
    { type: 'obstacle_placed' }, { type: 'jump_rejected', playerId: 'blue' },
  ] }), { red: 1, blue: 0 });
});

test('placement body excludes arbitrary targets, credentials and invalid catalog entries', () => {
  const options = [{ id: 'banana_peel' }];
  const valid = { assetId: 'banana_peel', lane: 1, progress: 130, route: 'left' };
  assert.deepEqual(parsePlacement(valid, options), valid);
  for (const invalid of [null, [], { ...valid, raceId: 'another-race' }, { ...valid, url: 'https://other.invalid' },
    { ...valid, admin: 'secret' }, { ...valid, assetId: 'boost_pad' }, { ...valid, lane: '1' },
    { ...valid, progress: NaN }, { ...valid, progress: '130' }, { ...valid, lane: 3 }, { ...valid, route: 'main' }]) {
    assert.throws(() => parsePlacement(invalid, options), error => error.status === 400);
  }
});

test('catalog only serves manifest obstacle PNGs, rejecting path traversal even in a manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obstacle-manifest-'));
  try {
    const item = { id: 'banana_peel', kind: 'obstacle', label: 'バナナ', glb: 'banana_peel.glb', sprite: 'banana_peel_iso.png', top: 'banana_peel_top.png' };
    await writeFile(join(root, 'manifest.json'), JSON.stringify([item, { ...item, id: 'sign', kind: 'sign' }]));
    const catalog = await loadObstacleCatalog(root);
    assert.deepEqual(catalog.options.map(option => option.id), ['banana_peel']);
    assert.equal(catalog.assets.size, 2);
    assert.equal(catalog.assets.get('/assets/props/banana_peel_iso.png'), join(root, 'banana_peel_iso.png'));
    assert.doesNotMatch(JSON.stringify(catalog.options), /\.glb/);
    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ ...item, sprite: '../secret.png' }]));
    await assert.rejects(loadObstacleCatalog(root), /素材パス/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('placement read model explicitly omits capabilities and private engine state', () => {
  const view = placementView({ raceId: 'race_safe', config: { admin: 'fixture-admin' }, finalState: {
    phase: 'racing', updatedAt: 5000, placedObstacleCount: 2, lastObstaclePlacedAt: 4200,
    token: 'capability', carContact: { private: true },
    players: { red: { progress: 90, lane: 1, nextObstacleIndex: 7, token: 'red-secret' }, blue: { progress: 80, lane: 2 } },
    course: { length: 200, obstacles: [{ id: 'manual-1', assetId: 'banana_peel', progress: 130, blockedLane: 1, route: 'left' }] },
  } });
  assert.equal(view.minProgress, 102);
  assert.equal(view.maxProgress, 197);
  assert.equal(view.count, 2);
  assert.equal(view.course.obstacles[0].lane, 1);
  assert.doesNotMatch(JSON.stringify(view), /fixture-admin|capability|red-secret|nextObstacleIndex|carContact/);
});

test('SSE decoder accepts fragmented CRLF and multiline data', async () => {
  const encoder = new TextEncoder();
  const chunks = ['event: message\r\nda', 'ta: {"value":\r\n', 'data: 7}\r', '\n\r\n: heartbeat\n\ndata: [DONE]\n\n'];
  const received = [];
  await readEventStream(new ReadableStream({ start(controller) { for (const value of chunks) controller.enqueue(encoder.encode(value)); controller.close(); } }), value => received.push(value));
  assert.deepEqual(received, [{ value: 7 }]);
});

test('mocked two-browser run enforces local origin, uploads frames, and deletes both sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'race-operator-test-'));
  const savedFetch = globalThis.fetch;
  const config = { key: 'fixture-openai', admin: 'fixture-admin', origin: 'https://game.invalid' };
  const sessions = new Map();
  const deleted = new Set();
  const approvals = [];
  const uploads = new Set();
  const decisionResults = new Set();
  let decisionRequests = 0;
  let finishOnStop = false;
  let rejectDeletes = false;
  let roomCount = 0;
  const placements = [];
  let rejectPlacement = true;
  let placedObstacles = [];
  let lastPlacedAt = 0;
  let placementGate = null;
  let releasePlacement = () => {};
  const observedState = finished => ({ phase: finished ? 'finished' : 'racing', winner: finished ? 'red' : null,
    updatedAt: Date.now(), placedObstacleCount: placedObstacles.length, lastObstaclePlacedAt: lastPlacedAt,
    players: { red: { progress: finished ? 200 : 100, lane: 0, collisionCount: 1 }, blue: { progress: finished ? 185 : 90, lane: 2, collisionCount: 2 } },
    course: { length: 200, junctions: [{ id: 'fork-2', name: 'CROSSOVER', start: 122, end: 160, routes: { left: { name: 'TECHNICAL' }, right: { name: 'WIDE' } } }], obstacles: [...placedObstacles] },
    history: [{ type: 'ready', playerId: 'red' }, { type: 'lane_change', playerId: 'red' }, { type: 'speed_change', playerId: 'blue' }],
  });
  const encoder = new TextEncoder();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1') return savedFetch(url, init);
    if (target.hostname === 'game.invalid') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-admin');
      if (target.pathname === '/api/races') {
        placedObstacles = []; lastPlacedAt = 0;
        const id = `race_fixture_${++roomCount}`;
        return json({ id, playerUrls: { red: `https://game.invalid/play/${id}/red#red-secret`, blue: `https://game.invalid/play/${id}/blue#blue-secret` }, spectatorUrl: `https://game.invalid/race/${id}` }, 201);
      }
      if (target.pathname.includes('/frame/')) { uploads.add(target.pathname.split('/').at(-1)); return json({ ok: true }); }
      if (target.pathname.endsWith('/telemetry')) return json({ ok: true });
      if (target.pathname.endsWith('/stop')) return json({ state: observedState(true), telemetry: {} });
      if (target.pathname.endsWith('/obstacles')) {
        placements.push({ path: target.pathname, body: JSON.parse(init.body) });
        if (rejectPlacement) return json({ error: '車の12以上前方に設置してください。' }, 409);
        await placementGate;
        const body = JSON.parse(init.body);
        placedObstacles.push({ id: 'manual-1', assetId: body.assetId, blockedLane: body.lane, progress: body.progress, route: body.route, junctionId: 'fork-2' });
        lastPlacedAt = Date.now();
        return json({ state: observedState(false), telemetry: {} }, 201);
      }
      return json({ state: observedState(uploads.size === 2 && decisionResults.size === sessions.size && !finishOnStop), telemetry: {} });
    }
    assert.equal(target.origin, 'https://api.openai.com');
    assert.equal(init.headers.Authorization, 'Bearer fixture-openai');
    if (target.pathname === '/v1/decisions') {
      decisionRequests++;
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.ok(body.input[0].content.some(item => item.type === 'input_image'));
      return json({ answers: [
        { type: 'choice', name: 'action', choice: 'lane_left', confidence: 0.9 },
        { type: 'predicate', name: 'obstacle_risk', probability: 0.8 },
        { type: 'predicate', name: 'rival_risk', probability: 0.2 },
      ] });
    }
    assert.equal(init.headers['OpenAI-Beta'], 'agents=v1');
    if (target.pathname === '/v1/agents/sessions') {
      const body = JSON.parse(init.body);
      assert.equal(body.agent.tools[0].type, 'computer_use');
      assert.equal(body.agent.tools[1].name, 'decide_drive');
      assert.equal(body.environment.desktop.enabled, true);
      const id = `sess_fixture_${sessions.size}`;
      sessions.set(id, { initialInput: false, controller: null });
      return json({ id }, 201);
    }
    const id = target.pathname.split('/')[4];
    const session = sessions.get(id);
    assert.ok(session);
    if (init.method === 'DELETE') {
      if (rejectDeletes) return json({ error: { message: 'Fixture cleanup denied' } }, 403);
      deleted.add(id); return new Response(null, { status: 204 });
    }
    if (!target.pathname.endsWith('/events')) return json({ required_actions: session.functionPending ? [
      { type: 'function_call', name: 'decide_drive', arguments: {}, turn_id: `${id}_turn`, call_id: `${id}_decision` },
    ] : [
      { type: 'computer_use_approval_request', request_id: `${id}_origin`, request: { type: 'browser_origin_access', origin: 'https://game.invalid' } },
      { type: 'computer_use_approval_request', request_id: `${id}_other`, request: { type: 'browser_origin_access', origin: 'https://other.invalid' } },
      { type: 'computer_use_approval_request', request_id: `${id}_auth`, request: { type: 'browser_authentication' } },
    ] });
    if (!init.method) return new Response(new ReadableStream({ start(controller) {
      session.controller = controller;
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const event = JSON.parse(init.body).events[0];
    const emit = item => session.controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
    if (event.type === 'agent.session.input.message') {
      assert.ok(init.headers['Idempotency-Key']);
      assert.equal(session.initialInput, false);
      session.initialInput = true;
      emit({ type: 'agent.session.requires_action', event_id: `${id}_action` });
    }
    if (event.type === 'agent.session.input.computer_use_approval_request_result') {
      approvals.push(event.response);
      if (event.response.type === 'browser_authentication') {
        emit({ type: 'agent.session.turn.item.done', event_id: `${id}_image`, item: { id: `${id}_tool`, type: 'computer_use_call', title: 'Fixture screen', output: { type: 'computer_screenshot', image_url: 'data:image/jpeg;base64,YQ==' } } });
        session.functionPending = true;
        emit({ type: 'agent.session.requires_action', event_id: `${id}_function` });
        // A second event for the same required call must not call Decisions twice.
        emit({ type: 'agent.session.requires_action', event_id: `${id}_function_repeated` });
      }
    }
    if (event.type === 'agent.session.input.tool_result') {
      assert.equal(event.turn_id, `${id}_turn`);
      assert.equal(event.call_id, `${id}_decision`);
      assert.equal(event.success, true);
      assert.equal(JSON.parse(event.output).action, 'lane_left');
      decisionResults.add(id);
    }
    return json({ accepted: true }, 202);
  };
  const port = 4198;
  const operator = await createOperatorServer({ port, proofFile: join(directory, 'proof.json'), loadConfig: async () => config });
  await new Promise(resolve => operator.server.listen(port, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    const post = (path, body = {}) => savedFetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) {
        const state = await (await savedFetch(base + '/api/status')).json();
        if (predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('Operator did not reach the expected state');
    };
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(base + '/api/status', { headers: { Host: `evil.invalid:${port}` } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(reboundStatus, 403);
    const catalog = await (await savedFetch(base + '/api/obstacle-options')).json();
    assert.equal(catalog.options.length, 9);
    assert.ok(catalog.options.some(option => option.id === 'banana_peel'));
    assert.ok(catalog.options.every(option => !['boost_pad', 'chevron_sign', 'speed_limit_80', 'speed_radar'].includes(option.id)));
    const sprite = await savedFetch(base + catalog.options[0].sprite);
    assert.equal(sprite.status, 200);
    assert.equal(sprite.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await sprite.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await savedFetch(base + '/assets/props/chevron_sign_iso.png')).status, 404);
    assert.equal((await savedFetch(base + '/assets/props/..%2f..%2f.dev.vars')).status, 404);
    assert.equal((await post('/api/obstacles', { assetId: 'banana_peel', lane: 1, progress: 130 })).status, 409);
    assert.equal(placements.length, 0);
    assert.equal((await savedFetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await savedFetch(base + '/api/start', { method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const started = await savedFetch(base + '/api/start', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 202);
    let state;
    for (let i = 0; i < 70; i++) {
      state = await (await savedFetch(base + '/api/status')).json();
      if (state.canStart) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.stage, 'completed', state.error || JSON.stringify(state));
    assert.equal(state.canStart, true);
    assert.equal(state.canReset, true);
    assert.equal(state.cleanupPending, false);
    const firstRun = state;
    assert.equal(sessions.size, 2);
    assert.equal(deleted.size, 2);
    assert.equal(uploads.size, 2);
    assert.equal(approvals.filter(value => value.decision === 'approve').length, 2);
    assert.equal(approvals.filter(value => value.decision === 'deny').length, 2);
    assert.equal(approvals.filter(value => value.action === 'cancel').length, 2);
    for (const color of ['red', 'blue']) { assert.equal(state.players[color].screenshots, 1); assert.equal(state.players[color].cleanupDeleted, true); }
    assert.doesNotMatch(JSON.stringify(state), /fixture-admin|fixture-openai|red-secret|blue-secret/);
    const proof = JSON.parse(await readFile(join(directory, 'proof.json'), 'utf8'));
    assert.equal(proof.computerUseVerified, true);
    assert.equal(proof.winner, 'red');
    assert.equal(proof.finalState.players.red.progress, 200);
    assert.equal(proof.finalState.players.blue.collisionCount, 2);
    assert.deepEqual(proof.drivingInputs, { red: 1, blue: 1 });
    assert.equal(proof.drivingVerified, true);
    assert.equal(proof.decisionsVerified, true);
    assert.equal(decisionRequests, 2);
    for (const color of ['red', 'blue']) assert.equal(proof.players[color].decisions, 1);

    // Reset only clears local display state; it does not create a room or browser.
    assert.equal((await savedFetch(base + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await post('/api/reset')).status, 200);
    assert.equal((await post('/api/reset')).status, 200);
    state = operator.status();
    assert.equal(state.stage, 'idle');
    assert.equal(state.canStart, true);
    assert.equal(state.canReset, false);
    assert.equal(state.cleanupPending, false);
    assert.deepEqual(state.players, {});
    assert.equal(state.raceId, undefined);
    assert.equal(roomCount, 1);
    assert.equal(sessions.size, 2);

    // A stop response is authoritative when the race crossed the line before cancellation.
    finishOnStop = true;
    uploads.clear();
    assert.equal((await savedFetch(base + '/api/start', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 202);
    for (let i = 0; i < 70; i++) {
      if (uploads.size === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(uploads.size, 2);
    assert.equal((await post('/api/reset')).status, 409);
    assert.equal((await post('/api/start')).status, 409);
    assert.equal(operator.status().canStart, false);
    assert.equal(operator.status().canReset, false);
    await waitFor(value => value.canPlaceObstacle);
    const place = { assetId: 'banana_peel', lane: 1, progress: 130, route: 'left' };
    for (const headers of [
      { 'Content-Type': 'application/json' },
      { Origin: 'https://game.invalid', 'Content-Type': 'application/json' },
      { Origin: base, 'Content-Type': 'text/plain' },
    ]) {
      const response = await savedFetch(base + '/api/obstacles', { method: 'POST', headers, body: JSON.stringify(place) });
      assert.ok([403, 415].includes(response.status));
    }
    assert.equal((await post('/api/obstacles', { ...place, raceId: 'another-race' })).status, 400);
    assert.equal((await post('/api/obstacles', { ...place, assetId: 'boost_pad' })).status, 400);
    assert.equal(placements.length, 0, 'rejected local requests must not reach the remote API');
    const beforePlacement = structuredClone(operator.status().placement);
    const rejectedPlacement = await post('/api/obstacles', place);
    assert.equal(rejectedPlacement.status, 409);
    assert.match((await rejectedPlacement.json()).error, /12以上前方/);
    assert.deepEqual(operator.status().placement.course, beforePlacement.course);
    assert.equal(operator.status().placement.count, 0);
    rejectPlacement = false;
    placementGate = new Promise(resolve => { releasePlacement = resolve; });
    const placing = post('/api/obstacles', place);
    await waitFor(value => !value.canPlaceObstacle);
    assert.equal((await post('/api/obstacles', place)).status, 409, 'duplicate in-flight local placements are rejected');
    releasePlacement();
    const placed = await placing;
    assert.equal(placed.status, 201);
    const placementResponse = await placed.json();
    assert.equal(placementResponse.placement.count, 1);
    assert.equal(placementResponse.placement.course.obstacles[0].assetId, 'banana_peel');
    assert.doesNotMatch(JSON.stringify(placementResponse), /fixture-admin|fixture-openai|red-secret|blue-secret/);
    assert.deepEqual(placements, [
      { path: '/api/races/race_fixture_2/obstacles', body: place },
      { path: '/api/races/race_fixture_2/obstacles', body: place },
    ]);
    await savedFetch(base + '/api/stop', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await post('/api/obstacles', place)).status, 409);
    assert.equal(placements.length, 2);
    for (let i = 0; i < 70; i++) {
      state = await (await savedFetch(base + '/api/status')).json();
      if (state.canStart) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.stage, 'completed', state.error || JSON.stringify(state));
    assert.equal(state.gamePhase, 'finished');
    assert.equal(state.winner, 'red');
    assert.equal(deleted.size, 4);
    assert.notEqual(state.id, firstRun.id);
    assert.notEqual(state.raceId, firstRun.raceId);
    for (const color of ['red', 'blue']) assert.notEqual(state.players[color].sessionId, firstRun.players[color].sessionId);

    // Starting directly after completion still works; cleanup failure must keep its IDs.
    finishOnStop = false;
    rejectDeletes = true;
    uploads.clear();
    assert.equal((await post('/api/start')).status, 202);
    state = await waitFor(value => value.stage === 'failed' && value.canReset);
    const failedRun = state;
    assert.equal(state.canStart, false);
    assert.equal(state.cleanupPending, true);
    assert.equal((await post('/api/start')).status, 409);
    assert.equal((await post('/api/reset')).status, 409);
    assert.equal(operator.status().id, failedRun.id);
    assert.equal(operator.status().players.red.sessionId, failedRun.players.red.sessionId);
    assert.equal(operator.status().cleanupPending, true);
    assert.equal(roomCount, 3);
    assert.equal(sessions.size, 6);

    // The next reset retries deletion of existing sessions without launching any new ones.
    rejectDeletes = false;
    assert.equal((await post('/api/reset')).status, 200);
    assert.equal(operator.status().stage, 'idle');
    assert.equal(operator.status().canStart, true);
    assert.equal(operator.status().cleanupPending, false);
    assert.equal(deleted.size, 6);
    assert.equal(roomCount, 3);
    assert.equal(sessions.size, 6);
  } finally {
    releasePlacement();
    await operator.stop();
    globalThis.fetch = savedFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('start and reset stay locked while configuration and the previous proof are pending', async () => {
  const savedFetch = globalThis.fetch;
  let releaseConfig, configEntered, releaseProof;
  const configurationStarted = new Promise(resolve => { configEntered = resolve; });
  const configurationGate = new Promise(resolve => { releaseConfig = resolve; });
  const proofGate = new Promise(resolve => { releaseProof = resolve; });
  let sessions = 0, rooms = 0, deletes = 0;
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1') return savedFetch(url, init);
    if (target.hostname === 'game.invalid') {
      if (target.pathname === '/api/races') {
        rooms++;
        return json({ id: 'race_pending', playerUrls: { red: 'https://game.invalid/play/race_pending/red#red-secret', blue: 'https://game.invalid/play/race_pending/blue#blue-secret' }, spectatorUrl: 'https://game.invalid/race/race_pending' });
      }
      if (target.pathname.endsWith('/telemetry')) return json({ ok: true });
      return json({ state: { phase: 'finished', winner: 'tie', history: [] } });
    }
    assert.equal(target.origin, 'https://api.openai.com');
    if (target.pathname === '/v1/agents/sessions') return json({ id: `sess_pending_${++sessions}` });
    if (init.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    if (!init.method && target.pathname.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    return json({ accepted: true, required_actions: [] });
  };
  const port = 4199;
  const operator = await createOperatorServer({ port, loadConfig: async () => {
    configEntered();
    await configurationGate;
    return { key: 'fixture-openai', admin: 'fixture-admin', origin: 'https://game.invalid' };
  }, saveProof: () => proofGate });
  await new Promise(resolve => operator.server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${port}`;
  const post = path => savedFetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate(operator.status())) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Operator did not reach the expected pending state');
  };
  try {
    const starting = post('/api/start');
    await configurationStarted;
    assert.equal(operator.status().canStart, false);
    assert.equal(operator.status().canReset, false);
    assert.equal((await post('/api/start')).status, 409);
    assert.equal((await post('/api/reset')).status, 409);
    releaseConfig();
    assert.equal((await starting).status, 202);
    await waitFor(state => state.stage === 'completed');
    assert.equal(operator.status().canStart, false);
    assert.equal(operator.status().canReset, true);
    assert.equal((await post('/api/start')).status, 409);

    const resetting = post('/api/reset');
    await waitFor(state => state.canReset === false);
    assert.equal(operator.status().stage, 'completed');
    assert.equal((await post('/api/start')).status, 409);
    assert.equal((await post('/api/reset')).status, 409);
    releaseProof();
    assert.equal((await resetting).status, 200);
    assert.equal(operator.status().stage, 'idle');
    assert.equal(operator.status().canStart, true);
    assert.equal(rooms, 1);
    assert.equal(sessions, 2);
    assert.equal(deletes, 2);
  } finally {
    releaseConfig();
    releaseProof();
    await operator.stop();
    globalThis.fetch = savedFetch;
  }
});
