# Roadster 2D game assets

保存版の `releases/roadster_v1.blend` から、Blenderでレンダリングした非公式の車両スプライトです。元記事の写真はこのパックに含めていません。

## 収録内容

- `roadster_8dir_sheet.png` — 2048×1024、透過RGBA。512×512の8コマを4列×2行に配置。
- `roadster_8dir_sheet.webp` — 同じ配置の軽量Web用データ。
- `roadster_8dir_sheet.json` — 各コマの位置、向き、接地点のピボット。
- `front.png` など8方向の単体透過PNG。
- `top.png` / `top.webp` — 見下ろし視点。
- `roadster_8dir_preview.jpg` — 配置確認用。ゲーム素材には透過版を使用。
- `roadster_all_views_preview.jpg` — 上面図を含む9視点の一覧。
- `top_preview.jpg` — 上面図だけを見やすい背景で表示した確認用画像。
- `*_768.png` — 768×768のレンダー原版。

## コマ順

1行目: front, front_left, left, rear_left

2行目: rear, rear_right, right, front_right

向きは車の正面を0°として45°刻みです。画像の透明余白は各方向で同じ512×512の枠を維持し、位置合わせしやすくしています。地面に置く位置はJSONの各コマの`pivot`を使ってください。
