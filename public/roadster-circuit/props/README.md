# Roadster レース用小物セット

13種類の低ポリゴン小物です。各小物に個別のGLB、斜め視点と見下ろし視点の透過PNG（384×384）があります。`roadster_race_props.zip` にWeb・2Dゲーム向けファイルをまとめています。Blenderで編集する場合は `roadster_race_props.blend` を開いてください。

| ID | 内容 | 用途 |
| --- | --- | --- |
| `traffic_cone` | 反射帯付きコーン | 接触すると減速 |
| `water_barrier` | 白い反射帯付きバリケード | 接触すると減速 |
| `tire_stack` | 3段タイヤ | 接触すると減速 |
| `chevron_sign` | 青いカーブ案内標識 | コース案内 |
| `speed_limit_80` | 制限速度80の標識 | 速度目安 |
| `speed_radar` | デジタル速度表示板 | ゲーム内で現在速度を表示 |
| `boost_pad` | 発光する加速パネル | 短時間加速 |
| `banana_peel` | 4枚に開いたバナナの皮 | スピン |
| `rainbow_oil` | 虹色オイル | 一時的にハンドルが反転 |
| `rubber_duck` | 巨大なアヒル | 車を横に弾く |
| `sticky_donut` | ピンクの巨大ドーナツ | 一時的に加速しづらくなる |
| `ufo_magnet` | 光るUFO | 車を引き寄せる |
| `beach_ball` | 跳ねるビーチボール | 車を横に弾く |

各小物のファイル名、ポリゴン数、容量は `manifest.json` にあります。13個のGLB合計は約286KBで、画像テクスチャは使っていません。`speed_radar.glb` にはサンプルの「088」が入っています。`race.html` では画面の前に動的な数字を重ね、現在速度をkm/hで表示します。80km/hを超えると赤くなります。

2D素材は `<ID>_iso.png` と `<ID>_top.png` です。まとめて使う場合は `roadster_props_iso_atlas.png` または `roadster_props_top_atlas.png` と対応するJSONを使ってください。PNGは透過背景です。

再生成: Blenderで `build_props.py` を実行し、Pythonで `package_props.py` を実行します。
