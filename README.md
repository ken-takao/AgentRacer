# Agent Grand Prix — AIが運転し、人が熱狂するレース

**考えている間にも、ライバルは先へ進む。**

赤のSCARLETと青のCOBALT。2つの独立したAIエージェントが、同じコースでゴールを競います。各AIの画面を **Decisions API** が読み、車線・速度・分岐を選択。**Agents APIのComputer Use** がその指示を画面上のボタン操作として実行し、**GPT-Live** の日本語実況がレースを盛り上げます。

AIの判断中もレースは止まりません。加速するか、相手をかわすか、速いが障害物のある分岐へ入るか。その判断と操作の時間まで含めて観戦する、リアルタイムのAIレースです。

**[公開デモを開く](https://agent-grand-prix.petertakao.chatgpt.site/)** · **[AI実況を試聴する](https://agent-grand-prix.petertakao.chatgpt.site/preview/narration)** · **[3Dプレビューを見る](https://agent-grand-prix.petertakao.chatgpt.site/preview/roadster)**

観戦にAPIキーやマイクは不要です。AI対戦の開始は主催者のローカルオペレーターから行います。開催中でない場合も3Dプレビューと収録済みの実況を確認できます。プレビューは実際のAI対戦とは別で、実況サンプルと3Dのデモ走行は連動しません。

## 観戦の見どころ

- **同じコース、別々の判断。** 赤と青は独立したブラウザーで自分の画面を見ます。相手の接近や障害物に対し、どちらが先に反応するかを見比べられます。
- **速さだけでは勝てない。** TURBOで攻めると接触の危険も増します。相手との接触は両車の減速につながり、分岐では速さと避けやすさの選択が生まれます。
- **AIの操作と結果を一緒に見る。** 3D中継に加え、両AIの実際のスクリーンショットと、Decisions APIが選んだ操作・判断回数・応答時間を表示します。
- **接触も逆転も日本語で実況。** オリジナル実況者「ピット・ハヤテ」がサーバーで確認した出来事を伝えます。音を出せない場所でも発話の字幕で追えます。

## 今回使った新機能と、その役割

DevDay 2026当日の新機能を中心に、その前後に公開されたAPIを組み合わせています。公開日は [OpenAI公式Changelog](https://developers.openai.com/api/docs/changelog) に基づき、DevDay当日（2026年9月29日）の追加と前後のリリースを区別しています。

| 機能・使用モデル | 公開時期 | 本作のどこで、どう使うか | この体験に必要な理由・実装 |
| --- | --- | --- | --- |
| **Agents API + Computer Use** / `gpt-6-astra` | **9月29日：Agents APIにComputer Use追加**。Agents API本体は9月10日 | 赤・青に1つずつOpenAI-hostedブラウザーを作成。スクリーンショットを取得し、選ばれた車線・速度・分岐のボタンを操作 | 「画面を見て操作するAI」を実際の対戦者にする。[セッション作成・イベント購読・操作指示](operator/server.mjs) / [公式ドキュメント](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use) |
| **Decisions API** / `gpt-6-luna` | 10月6日：ベータ公開 | 各車の最新スクリーンショットと固定の走行ルールを入力し、9種類の操作から1つを選ぶ。同時に障害物と相手車両の接近リスクを推定 | 車線・速度・分岐という有限の選択を、型付きの結果として操作担当へ渡す。[判断クライアント](operator/drive-decisions.mjs) / [公式ドキュメント](https://developers.openai.com/api/docs/guides/decisions) |
| **GPT-Live** / `gpt-live-1`、日本語音声 `shida` | 本体は9月10日。**Shidaは10月16日追加** | 各レースに1つの実況セッションを用意。開始・接触・分岐・逆転・結果の確定情報を送り、日本語音声と実際の発話の字幕を観戦者へ配信 | AIの行動を、観客が追いやすいスポーツ中継にする。[実況方針](operator/narration-director.mjs) / [音声接続](operator/live-narrator.mjs) / [公式ドキュメント](https://developers.openai.com/api/docs/guides/live) |

Three.js、Cloudflare Workers、D1、R2は描画・配信・保存を支える基盤です。新しいOpenAI機能の活用は、上記の「画面操作」「走行判断」「音声実況」の役割で説明しています。

### Decisions API：最新の画面から、次の1操作を選ぶ

[`operator/drive-decisions.mjs`](operator/drive-decisions.mjs) から `POST /v1/decisions` を呼びます。1回のリクエストで、画像に対する3つの質問を送ります。

| 質問 | 型 | 得られる結果と使い道 |
| --- | --- | --- |
| `action` | `choice` | 左・中央・右への車線変更、SLOW・NORMAL・TURBO、左右の分岐、待機の**10択**。選択結果を固定の操作指示に変換 |
| `obstacle_risk` | `predicate` | 現在の車線・速度を維持した場合の、近い障害物への接触リスクの推定値 |
| `rival_risk` | `predicate` | 現在の車線・速度を維持した場合の、相手車両への接触リスクの推定値 |

リスクは画像からの推定で、実際の接触判定はゲームエンジンが行います。モデルに渡すのは本人の画面と固定ルールで、ゲーム内部の全状態や未来の障害物マップは渡しません。推定値を閾値で処理して操縦するのではなく、`action` の選択結果を使います。

### Agents API：選ばれた操作をブラウザーで実行する

各エージェントが `decide_drive({})` を呼ぶと、オペレーターがそのセッションの最新画像をDecisions APIへ渡します。返された1操作をComputer Useで実行し、また新しい画面を取得します。READYだけは走行判断を経ずに押せます。

```text
各車の2D操作画面
    ↓ Computer Useでスクリーンショット取得
decide_drive({}) → Decisions APIが次の1操作を選択
    ↓ 固定の操作指示
Computer Useが画面上のボタンを操作
    ↓
サーバーが走行・接触・勝敗を更新 → 次の画面へ
    ├─ 3D観戦画面へ位置・進路を配信
    └─ 確定した出来事 → GPT-Live → 日本語音声・字幕
```

このループを赤・青それぞれが独立して実行します。レースの時計はループを待たずに進みます。オペレーターは走行操作をゲームAPIへ直接送らず、エージェントにボタンを押させます。DOM・スクリプト・直接APIによる操縦は禁止する指示を与えていますが、画像だけの利用を強制するAPIモードではないため、モデルへの指示としての制約です。

### GPT-Live：走行と並行して、日本語で実況する

[`operator/narration-director.mjs`](operator/narration-director.mjs) がゲームの確定情報から実況する出来事を選び、[`operator/live-narrator.mjs`](operator/live-narrator.mjs) が `session.commentary.append` でGPT-Liveへ送ります。生成された音声と `session.output_transcript.delta` の実際の発話テキストを共有します。

実況セッションはレースごとに1つで、観戦者ごとに音声を生成し直しません。「実況を聴く」で再生を有効にでき、ミュート中も字幕を表示します。発話中はBGMを下げ、実況側の障害で運転は止めない構成です。音声は組み込みのShidaを使用しています。

## ハッカソンの4つの観点と本作の工夫

[イベントの審査基準](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo) に沿って、作品の狙いと確認できる箇所をまとめます。

| 観点 | 本作で伝えたいこと | 確認できる箇所 |
| --- | --- | --- |
| **新機能の活用** | DevDayで追加されたComputer Useを実際の操縦に使い、Decisions APIの選択とGPT-Liveの実況を組み合わせる。各APIに明確な役割を持たせた | 上記のAPI別説明、[operator](operator/)、観戦画面のAI視点と判断表示 |
| **使いやすさ** | 観客は公開URLを開いて見るだけ。AIの準備状況、赤青の進捗、操作内容を表示。音声・字幕、AI画面の拡大、狭い画面向け配置を用意 | 公開デモ、[観戦UI](app/race-ui.tsx)、[準備表示](app/race-preparation.tsx)、[音声・字幕UI](app/race-narration.tsx) |
| **有用性** | Computer Useの動きを、専門知識がなくても見比べられる体験にする。画面認識・操作選択・実際の操作結果を観察でき、AIの学習会やデモに使える | 2つのAI視点、判断回数・応答時間・接触回数の表示、[検証方法](#検証方法と確認範囲) |
| **独創性** | 仕事を代行するエージェントを「観戦する対戦者」にする。止まらないレースに画面認識と操作の時間が加わり、実況とともに判断の違いを楽しめる | 共有コース上の接触・分岐、独立した2セッション、3D中継と日本語実況 |

学習会・デモへの応用は本作の利用提案です。異なるモデル間の性能差や教育効果を定量的に実証したものではありません。

## デモの見方

1. [公開デモ](https://agent-grand-prix.petertakao.chatgpt.site/) を開きます。「レースを観戦する」が表示されていれば、その試合へ進みます。終了済みの場合は結果画面になります。
2. AI対戦中は、左の3D中継と右の2つのAI視点を見比べます。Decisions APIの操作表示で、加速・車線変更・分岐の選択を追えます。AI視点は拡大できます。
3. 「実況を聴く」を押すと日本語実況が流れます。音を出せない場合は字幕で追えます。
4. 新しい対戦は、主催者がローカルの `http://127.0.0.1:4180/` から「2つのエージェントを起動」で開始します。公開ページのオペレーターリンクも、開いた人自身のPCを指します。

試合を開始できない環境では、[3Dプレビュー](https://agent-grand-prix.petertakao.chatgpt.site/preview/roadster) と [収録済みGPT-Live実況](https://agent-grand-prix.petertakao.chatgpt.site/preview/narration) を確認できます。これらの再生は新しいAIセッションを起動しません。

## ゲームのルール

- 両車がREADYになると5秒後にスタート。200ユニットへ先に到達した車が勝ち、最大180秒で終了します。
- 車線は左・中央・右、速度はSLOW・NORMAL・TURBO。追突・側面接触はサーバーが判定し、両車を4秒間減速させます。車線変更で離れれば追い越せます。
- シードから3種類の蛇行・立体交差コースを選び、2か所の分岐でLEFT/RIGHTを選択します。TECHNICALは速度1.18倍・障害物2か所、WIDEは0.94倍・障害物なし。左右の割当と障害物レーンもシードで変わります。
- 分岐の選択は進入時に確定。別ルートの車同士は接触せず、合流すると再び接触の対象になります。

上記は新規レース（v2）のルールです。保存済みの旧レース（v1）は元のルールを保持します。AI操作画面は2D、観戦画面はサーバーの確定状態に基づく3D表示です。

## セットアップ・実行

Node.js 22.13以降を使用します。

```sh
npm ci
cp .env.example .env.local
cp .dev.vars.example .dev.vars
```

| ファイル | 変数 | 用途 |
| --- | --- | --- |
| `.env.local` | `OPENAI_API_KEY` | Agents API・Decisions API・GPT-Liveにアクセスするキー。利用するAPI・モデルへのアクセスが必要 |
| `.dev.vars` | `RACE_ADMIN_KEY` | 対戦作成・画像・実況転送用の管理キー。自分の公開ゲーム側にも同じ値を設定 |
| `.dev.vars` | `GAME_ORIGIN` | 自分がデプロイしたゲームのHTTPSオリジン |

各変数は環境変数でも設定できます。実際の設定ファイルと実行ログはGitの追跡対象外です。

公開ゲームはSites向けのVinext / Cloudflare Workers構成で、D1とR2を使用します。`.openai/hosting.json` にはストレージ宣言だけを保持しています。自分のSitesプロジェクトを登録してIDを設定し、Sitesのsource/build/packageワークフローで公開します。D1スキーマは `drizzle/` のマイグレーションで管理します。このリポジトリをコピーしただけでは、上記の公開デモの運用環境へ接続しません。

公開後、ローカルでオペレーターを起動します。

```sh
npm run operator
```

`http://127.0.0.1:4180/` を開き「2つのエージェントを起動」を押します。観戦タブが開かない場合は「このレースを観戦する」を押してください。AI対戦は2つのAgents APIセッション、繰り返しのDecisions API呼び出し、実況用GPT-Liveを利用し、API料金が発生します。実況を無効にする場合は `NARRATION_ENABLED=0` を設定します。詳しい設定・終了処理は [operator/README.md](operator/README.md) を参照してください。

`npm run dev` でフロントエンドをローカル確認できます。ただしOpenAI-hostedブラウザーはこのPCのlocalhostに接続できないため、AI対戦には公開された `GAME_ORIGIN` が必要です。ローカルの `/preview/roadster`・`/preview/narration`・`/preview/assets` は、それぞれ車体表示・収録実況・素材一覧の確認用です。

### 再対戦・停止

終了・停止後の「新しいレースを開始」は、別の試合と2つの新しいセッションを作成します。「表示をリセット」は操作画面を待機状態に戻し、新しいAPIセッションは起動しません。終了処理が失敗した場合は「終了処理を再試行してリセット」で旧セッションを片付けます。

公開の結果画面の「もう一度レースする」は主催者のPC上でローカル操作画面を開くためのリンクです。新しい試合ができると「次のレースを観戦する」も表示され、過去の結果は残ります。

## 検証方法と確認範囲

```sh
npm test
npx tsc --noEmit
npm run build
```

既存テストは、時刻に基づく走行、衝突、分岐、同時到着、停止、描画用補間に加え、Decisions APIの入力画像・10択・不正な回答・画像の期限切れ、実況のイベント選択・音声と字幕の処理を確認します。API連携のテストにはモックを使用し、実APIによるAI運転とは区別しています。

実走の確認では、オペレーターがGit管理外の `work/race-live-check.json` に結果を保存します。

| 確認する記録 | 分かること |
| --- | --- |
| `computerUseVerified` | 両セッションで操作イベントとスクリーンショットを観測したか |
| `decisionsVerified` | 両車でDecisions APIの有効な回答を1回以上受け取ったか |
| `drivingVerified` / `drivingInputs` | ゲーム履歴に実際の車線・速度・進路変更・ジャンプが記録されたか |
| `gamePhase` / `winner` / `finalState` | 試合が完了したか、中断したか、実際の結果はどうなったか |
| `players` / `narration` | ドライバーの終了処理、実況の状態・生成量・終了結果 |

APIが回答したこと、ボタン操作がゲームに反映されたこと、試合を完走したことは別の確認です。このREADMEは実装を説明しており、最新構成での実API完走や応答速度を保証するものではありません。観戦画面のAI視点は最新スクリーンショットで、動画ではありません。Decisions APIの応答時間にもComputer Useの操作時間は含まれません。

古い画像は再取得し、判断APIが3回連続で失敗すると中断します。公開ゲームはOpenAI APIキーを保持せず、課金を伴う起動・停止はループバック限定のローカルオペレーターが行います。プレイヤーURLの操作キーは試合・車両限定で、30分後に期限切れになります。

## コードの案内

| 場所 | 内容 |
| --- | --- |
| [operator/server.mjs](operator/server.mjs) | 2つのAgents APIセッション、イベント購読、画像・判断の転送、終了時削除 |
| [operator/drive-decisions.mjs](operator/drive-decisions.mjs) | 画像からの走行判断、回答の検証、固定操作指示への変換 |
| [operator/narration-director.mjs](operator/narration-director.mjs) / [operator/live-narrator.mjs](operator/live-narrator.mjs) | 実況イベントの選択、日本語音声生成、音声と字幕の配信 |
| [lib/race-engine.ts](lib/race-engine.ts) / [lib/race-course.ts](lib/race-course.ts) | 時計に基づく走行・接触・勝敗、シード付きコースと分岐 |
| [app/race-ui.tsx](app/race-ui.tsx) / [app/race-tactics.tsx](app/race-tactics.tsx) | 観戦・2D操作画面、相手車両、分岐、判断結果表示 |
| [app/api/races/](app/api/races/) | D1の共有状態、操作権限、R2の画像・実況・判断データ |
| [docs/architecture.md](docs/architecture.md) | 3D描画と通信の分離、カメラ、BGM、素材・独立した試作の詳細 |

## イベント・参考資料

- [DevDay Community Hackathon — ルール・審査基準](https://luma.com/OpenAIDevDay2026CommunityHackathonTokyo)
- [OpenAI API Changelog — 機能の公開日](https://developers.openai.com/api/docs/changelog)
- [Agents API Computer Use](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use)
- [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
- [GPT-Live](https://developers.openai.com/api/docs/guides/live)

Lumaには、新機能の活用・使いやすさ・有用性・独創性の4観点と、予選でOpenAIモデルによる自動評価を予定している旨が記載されています。本作でのDecisions APIの用途は**レース中の走行判断**です。大会側の審査処理とは別の実装です。
公開はSitesのsource/build/packageワークフローを使用。D1スキーマは `drizzle/` のマイグレーションで管理します。

## エアジャンプと人間の障害物配置

両ドライバー画面の `JUMP` または Space で0.8秒間ジャンプします。空中で通過した障害物は回避し、着地から2秒後に再使用できます。スピン中・レース開始前・終了後には使用できません。Decisions APIも画面のJUMP状態を見て選択し、Computer Useでボタンを押します。

オペレーター画面の「障害物を設置」から素材・レーン・距離・分岐を選びます。`public/roadster-circuit/props/manifest.json` の `kind: "obstacle"` のみ使用できます。両車より12ユニット以上前方、ゴールから3ユニット以上手前、同じ道・レーンの障害物から4ユニット以上離れた位置が対象です。最大20個／レース、設置間隔1.5秒です。バナナは接触地点で1.2秒停止・スピンし、その他の素材は減速します。スピン中に指定したレーン・速度は回復後に反映されます。

タイミング・回避・停止位置・配置検証はサーバーが管理し、操作と配置は同じD1のバージョン比較による更新を通します。管理キーはローカルオペレーターに留め、ブラウザーからの配置を固定したレースAPIへ中継します。拒否された操作は保存状態を変更しません。

`/preview/effects` はジャンプ・スピン・素材追加の表示確認用デモです。実際のAPI・衝突判定は実行しません。`npm test` には同時入力、空中のバナナ回避、同じバナナへの二重接触防止、動的配置による障害物判定の取りこぼし、権限拒否の検証が含まれます。
