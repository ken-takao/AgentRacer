"use client";

import { useEffect, useState } from 'react';
import { Flag, Radio, RefreshCw } from 'lucide-react';
import { observeRaceArrival, type RaceArrivalState } from '../lib/race-arrival';
import './race-arrival.css';

export function RaceArrival({ previousRaceId }: { previousRaceId?: string }) {
  const [state, setState] = useState<RaceArrivalState>({ status: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setState({ status: 'connecting' });
    return observeRaceArrival({ previousRaceId, onUpdate: setState,
      onReady: id => window.location.replace(`/race/${encodeURIComponent(id)}`),
    });
  }, [previousRaceId, attempt]);
  const waiting = ['connecting', 'waiting', 'active'].includes(state.status) || state.awaitingAvailability === true;
  const heading = state.status === 'active' ? 'レースへ移動しています' : waiting ? '次のレースを準備しています' : state.status === 'offline' ? 'まもなく、スタートラインへ。' : state.status === 'failed' ? 'レースの準備を再開できます' : 'レースへの接続を確認しています';
  const description = state.status === 'connecting' ? '開催中のレースを確認し、なければ新しい対戦をリクエストします。'
    : state.status === 'offline' && state.awaitingAvailability ? '主催者のオペレーターが開始できる状態になると、自動で準備を始めます。そのままお待ちください。'
    : state.status === 'active' ? 'SCARLET と COBALT のサーキットへ、自動で移動します。'
    : state.message || '2つのAIドライバーを迎える準備中です。そのままお待ちください。';
  return <section className={`race-arrival ${waiting ? 'is-waiting' : ''}`} aria-label="レースの自動スタート">
    <div className="arrival-label"><Radio size={13} /> AUTO START · SCARLET vs COBALT</div>
    <div className="arrival-heading"><Flag size={24} /><h2>{heading}</h2></div>
    <p role="status" aria-live="polite">{description}</p>
    {waiting ? <div className="arrival-runway" aria-hidden="true"><i /><i /></div> : <button className="button button-lime" type="button" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} />{state.status === 'offline' ? '接続を確認して開始' : 'もう一度準備する'}</button>}
    <span className="arrival-note">開催中ならそのまま合流 · 準備ができたら自動で観戦画面へ</span>
  </section>;
}
