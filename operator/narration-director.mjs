/** Select verified race facts, never controls or invented driver intentions. */
export const NARRATOR_INSTRUCTIONS = `あなたは架空のAIレース実況者「ピット・ハヤテ」。日本語だけで、熟練スポーツ実況者の明瞭な発音、豊かな抑揚、テンポのよい短い言葉で実況する。実在人物を演じたり声をまねたりしない。
赤い車はスカーレット、青い車はコバルト。両者を公平に応援する。これは二台のAIが操作するゲーム。観客に質問せず、一方向の中継を行う。マイクの無音は正常。外部情報やツールの依頼は不要。
送られる実況情報はゲームサーバーが確認した事実。新しい情報を優先し、古い出来事を現在進行形で繰り返さない。情報がない出来事、速度の単位、周回数、順位の逆転、故障、ドライバーの感情や意図を創作しない。ゴール・勝者は結果確定の情報が届くまで断定しない。
一つの実況情報につき必ず短い一文だけ、三秒以内で言い切る。その後は完全に黙り、次の実況情報を待つ。間を埋める雑談、同じ事実の言い換え、長い説明、繰り返しの自己紹介は禁止。接触や逆転は歯切れよく、ゴールは華やかに。常に叫び続けず強弱をつける。応援の指示が来たら「行け、スカーレット！」「コバルト、ここからだ！」など短い呼びかけを織り交ぜる。これは実況であり車への操作指示ではない。
カウントダウンの正確な数字を自己判断で読み上げない。準備完了はまだスタートではない。減速と停止を区別する。レース中止の場合、勝者を発表しない。終了を伝えたあとは新しい情報が届くまで静かにする。`;

const NAMES = { red: 'スカーレット', blue: 'コバルト' };
const eventKey = e => [e.type, e.at, e.playerId, e.obstacleId, e.junctionId, e.route].join(':');

export function createNarrationDirector({ now = Date.now, minGapMs = 2600, cheerGapMs = 10500, staleMs = 6500 } = {}) {
  const seen = new Map();
  const pending = new Map();
  const cooldown = new Map();
  let phase = null, latest = null, lastSent = -Infinity, lastCheer = -Infinity;
  let leader = null, candidate = null, candidateSince = 0, cheerIndex = 0;
  const previousSlow = { red: false, blue: false };
  const add = (id, kind, text, priority, at, ttl = staleMs) => {
    // Engine timestamps and wall clock can have an offset. Age facts within the
    // latest server snapshot, then spend only their remaining TTL in our queue.
    const age = Math.max(0, (latest?.updatedAt ?? at) - at);
    if (age >= ttl) return;
    pending.set(id, { id, kind, text, priority, at, expiresAt: now() + ttl - age });
  };
  function observe(state) {
    if (!state?.players?.red || !state?.players?.blue || !Number.isFinite(state.updatedAt)) return;
    // Polls can arrive out of order; old snapshots cannot resurrect a finished race.
    if (latest && state.updatedAt < latest.updatedAt) return;
    latest = state;
    const at = state.updatedAt;
    if (phase !== state.phase) {
      if (state.phase === 'countdown') add('countdown', 'countdown', '両車が準備完了。スタート前のカウントダウンに入った。まだ走行は始まっていない。', 80, at);
      if (state.phase === 'racing') {
        pending.delete('countdown');
        add('start', 'start', phase === 'countdown' || (state.startedAt && at - state.startedAt < staleMs)
          ? 'レースが今スタートした。スカーレットとコバルト、二台が走り出した。' : 'レースは走行中。スカーレットとコバルトの競争を実況する。', 90, at);
        lastCheer = now();
      }
      if (state.phase === 'finished' || state.phase === 'cancelled') {
        pending.clear();
        const winner = state.winner;
        if (state.phase === 'cancelled') add('cancelled', 'cancelled', 'レースが中止された。勝者の発表はない。中継を終了する。', 100, at, 20000);
        else if (winner === 'tie' || NAMES[winner]) {
          const result = winner === 'tie' ? '結果は同着、引き分け。' : `勝者は${NAMES[winner]}。`;
          add('finish', 'finish', `${state.finishReason === 'time_limit' ? '制限時間でレース終了。' : 'ゴール、レース終了。'}${result}これはサーバーで確定した結果。両車を称えて中継を締める。`, 100, at, 20000);
        }
      }
      phase = state.phase;
    }
    for (const event of state.history || []) {
      const id = eventKey(event);
      if (seen.has(id)) continue;
      seen.set(id, at);
      if (!Number.isFinite(event.at) || at - event.at > staleMs || state.phase !== 'racing') continue;
      const name = NAMES[event.playerId];
      if (event.type === 'car_collision') {
        add(id, 'contact', 'スカーレットとコバルトの車同士が接触。両車に一時的な減速が発生した。走行は続いている。', 85, event.at, 4000);
      } else if (event.type === 'collision' && name) {
        add(id, `obstacle:${event.playerId}`, `${name}が障害物に接触し、一時的な減速が発生した。停止やリタイアではない。`, 84, event.at, 4000);
      } else if (event.type === 'route_entered' && name && ['left', 'right'].includes(event.route)) {
        add(id, `route:${event.playerId}`, `${name}は${event.route === 'left' ? '左' : '右'}の分岐ルートに入った。`, 50, event.at);
      }
    }
    for (const [key, when] of seen) if (at - when > 60000) seen.delete(key);
    if (state.phase !== 'racing') return;
    for (const color of ['red', 'blue']) {
      const slowed = state.players[color].slowedUntil > at;
      if (previousSlow[color] && !slowed) add(`recovery:${color}:${at}`, `recovery:${color}`, `${NAMES[color]}の接触による減速が解消した。走行を続けている。`, 35, at);
      previousSlow[color] = slowed;
    }
    const gap = state.players.red.progress - state.players.blue.progress;
    const nextLeader = Math.abs(gap) > 1.2 ? (gap > 0 ? 'red' : 'blue') : null;
    if (nextLeader !== candidate) { candidate = nextLeader; candidateSince = at; }
    if (candidate && at - candidateSince >= 1200 && candidate !== leader) {
      if (leader) add(`lead:${candidate}:${at}`, 'lead', `${NAMES[candidate]}が先頭に変わった。位置情報で逆転を確認。`, 75, at);
      leader = candidate;
    }
    if (now() - lastCheer >= cheerGapMs && pending.size === 0) {
      const color = ['red', 'blue'][cheerIndex++ % 2];
      const description = Math.abs(gap) < 3 ? '二台の進行差はわずか。' : `${NAMES[gap > 0 ? 'red' : 'blue']}が進行距離で先行している。`;
      add(`cheer:${at}`, 'cheer', `${description}${NAMES[color]}へ短く、もっと走れと熱い応援を入れる。未確認の出来事は足さない。`, 10, at);
      lastCheer = now();
    }
  }
  function next({ force = false } = {}) {
    const time = now();
    for (const [id, item] of pending) if (item.expiresAt < time) pending.delete(id);
    const items = [...pending.values()].sort((a, b) => b.priority - a.priority || b.at - a.at);
    const item = items.find(item => time - (cooldown.get(item.kind) ?? -Infinity) >= (item.kind === 'contact' ? 4500 : 2000));
    if (!item || (!force && time - lastSent < (item.priority === 100 ? 600 : minGapMs))) return null;
    pending.delete(item.id);
    // A new critical event supersedes optional atmosphere from the same moment.
    if (item.priority >= 80) for (const [id, p] of pending) if (p.priority < 60) pending.delete(id);
    cooldown.set(item.kind, time); lastSent = time;
    return item;
  }
  return { observe, next, clear: () => pending.clear(), status: () => ({ phase, pending: pending.size, lastSent }) };
}
