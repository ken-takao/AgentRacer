"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import "./race-preparation.css";

const EXPECTED_SECONDS = 55;
type DriverReadiness = { joined: boolean; ready: boolean };

export function RacePreparation({ createdAt, serverNow, receivedAt, players }: {
  createdAt: number;
  serverNow: number;
  receivedAt: number;
  players: Record<"red" | "blue", DriverReadiness>;
}) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(performance.now());
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, []);
  // Anchor to the server's clock; polling and page reloads never reset the estimate.
  const elapsed = Math.max(0, (serverNow - createdAt + Math.max(0, clock - receivedAt)) / 1000);
  const remaining = Math.max(0, Math.ceil(EXPECTED_SECONDS - elapsed));
  const overdue = elapsed >= EXPECTED_SECONDS;
  const progress = Math.min(100, elapsed / EXPECTED_SECONDS * 100);
  const readyCount = Number(players.red.ready) + Number(players.blue.ready);

  return <section className={`race-preparation ${overdue ? "is-overdue" : ""}`} aria-label="AIドライバーの準備状況">
    <div className="preparation-top"><span><LoaderCircle size={15} />AI PREPARING</span><b>{readyCount} / 2 READY</b></div>
    <div className="preparation-time">
      <div><span>{overdue ? "目安の55秒を経過" : "準備完了の目安まで"}</span>
        <strong role="timer" aria-live="off">{overdue ? <>{Math.floor(elapsed)}<small>秒経過</small></> : <>{remaining}<small>秒</small></>}</strong></div>
      <p role="status">{overdue ? "もう少し時間がかかっています" : "2つのAIがブラウザーを起動し、コースに接続しています"}</p>
    </div>
    <div className="preparation-meter" role="progressbar" aria-label="準備時間の目安（55秒）" aria-valuemin={0} aria-valuemax={55} aria-valuenow={Math.min(55, Math.floor(elapsed))} aria-valuetext={overdue ? "目安の55秒を経過。AIの準備を待っています" : `約55秒の目安に対して${Math.floor(elapsed)}秒経過`}><i style={{ width: `${progress}%` }} /></div>
    <div className="preparation-drivers">{(["red", "blue"] as const).map(id => <span className={id} key={id}>
      {players[id].ready ? <Check size={12} /> : <i className="preparation-dot" />}
      <b>{id === "red" ? "SCARLET" : "COBALT"}</b>
      <span>{players[id].ready ? "READY" : players[id].joined ? "接続済み・READY待ち" : "ブラウザー準備中"}</span>
    </span>)}</div>
    <p className="preparation-note">55秒は目安です。両AIのREADY後、5秒のカウントダウンでスタート。</p>
  </section>;
}
