import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// These are UI hints. The race engine validates the live state atomically.
export const PLACEMENT_HINTS = Object.freeze({ ahead: 12, spacing: 4, limit: 20, cooldownMs: 1500, finishMargin: 3 });

export async function loadObstacleCatalog(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('障害物の素材一覧が不正です。');
  const options = [];
  const assets = new Map();
  for (const item of manifest) {
    if (item.kind !== 'obstacle') continue;
    if (!/^[a-z0-9_]+$/.test(item.id) || typeof item.label !== 'string' ||
        !/^[a-z0-9_]+\.glb$/.test(item.glb) || !/^[a-z0-9_]+\.png$/.test(item.sprite) || !/^[a-z0-9_]+\.png$/.test(item.top)) {
      throw new Error('障害物の素材パスが不正です。');
    }
    if (options.some(option => option.id === item.id)) throw new Error('障害物IDが重複しています。');
    for (const filename of [item.sprite, item.top]) assets.set(`/assets/props/${filename}`, resolve(root, filename));
    options.push({ id: item.id, label: item.label, sprite: `/assets/props/${item.sprite}`, top: `/assets/props/${item.top}`,
      effect: item.id === 'banana_peel' ? '停止して1.2秒スピン' : '接触すると減速' });
  }
  return { options, assets };
}

export function parsePlacement(body, options) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['assetId', 'lane', 'progress', 'route'].includes(key))) invalid('障害物の種類・レーン・位置・分岐のみ指定できます。');
  if (!options.some(option => option.id === body.assetId)) invalid('選択できない障害物です。');
  if (!Number.isInteger(body.lane) || body.lane < 0 || body.lane > 2) invalid('レーンは左・中央・右から選択してください。');
  if (typeof body.progress !== 'number' || !Number.isFinite(body.progress)) invalid('設置位置を数値で指定してください。');
  if (body.route !== undefined && body.route !== 'left' && body.route !== 'right') invalid('分岐は左または右を指定してください。');
  return { assetId: body.assetId, lane: body.lane, progress: body.progress, ...(body.route === undefined ? {} : { route: body.route }) };
}

/** An explicit allowlist keeps capabilities and private engine fields out of the local dashboard. */
export function placementView(run) {
  const state = run?.finalState;
  if (!state?.course || !state?.players?.red || !state?.players?.blue) return null;
  // Prefer the authoritative read model; older servers publish no pace rules.
  const rules = { ...PLACEMENT_HINTS, ahead: state.paceRules?.placementAhead === 60 ? 60 : PLACEMENT_HINTS.ahead };
  const players = Object.fromEntries(['red', 'blue'].map(color => [color, { progress: state.players[color].progress, lane: state.players[color].lane }]));
  return {
    raceId: run.raceId, phase: state.phase, updatedAt: state.updatedAt,
    players, count: state.placedObstacleCount || 0, lastPlacedAt: state.lastObstaclePlacedAt || 0,
    rules,
    minProgress: Math.max(players.red.progress, players.blue.progress) + rules.ahead,
    maxProgress: state.course.length - PLACEMENT_HINTS.finishMargin,
    course: { length: state.course.length,
      junctions: (state.course.junctions || []).map(junction => ({ id: junction.id, name: junction.name, start: junction.start, end: junction.end,
        routes: { left: { name: junction.routes.left.name }, right: { name: junction.routes.right.name } } })),
      obstacles: state.course.obstacles.map(obstacle => ({ id: obstacle.id, assetId: obstacle.assetId, progress: obstacle.progress,
        lane: obstacle.blockedLane, route: obstacle.route, junctionId: obstacle.junctionId })),
    },
  };
}
