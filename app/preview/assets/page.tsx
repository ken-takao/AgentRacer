import props from "@/public/roadster-circuit/props/manifest.json";
import sheet from "@/public/models/tesla-roadster/sprites/roadster_8dir_sheet.json";
import "./styles.css";

const propBase = "/roadster-circuit/props";
const carBase = "/models/tesla-roadster/sprites";
const directionNames: Record<string, string> = {
  front: "前",
  front_left: "左前",
  left: "左",
  rear_left: "左後",
  rear: "後",
  rear_right: "右後",
  right: "右",
  front_right: "右前",
};

export default function AssetPreviewPage() {
  return <main className="asset-preview">
    <header className="asset-preview-header">
      <div><span className="asset-eyebrow">AGENT GRAND PRIX / ASSET REVIEW</span><h1>Roadsterと障害物の素材</h1><p>配信中の2D画像を一覧で確認できます。画像を開くと元サイズで表示します。</p></div>
      <a href="/preview/roadster">走行プレビューへ →</a>
    </header>

    <section className="asset-section" aria-labelledby="roadster-heading">
      <div className="asset-section-heading"><div><span className="asset-eyebrow">01 / CAR</span><h2 id="roadster-heading">Roadster 2D</h2></div><a href={`${carBase}/roadster_8dir_sheet.png`}>8方向シートを開く ↗</a></div>
      <div className="asset-feature-grid">
        <a className="asset-feature" href={`${carBase}/roadster_8dir_sheet.png`}><img src={`${carBase}/roadster_8dir_sheet.webp`} alt="Roadsterの8方向スプライトシート" /><span>8方向スプライトシート · 4列×2行</span></a>
        <a className="asset-feature asset-feature-top" href={`${carBase}/top.png`}><img src={`${carBase}/top.webp`} alt="Roadsterの見下ろし画像" /><span>見下ろし視点</span></a>
      </div>
      <div className="asset-directions">{sheet.direction_order.map(direction => <a key={direction} href={`${carBase}/${sheet.frames[direction as keyof typeof sheet.frames].source}`}><img loading="lazy" src={`${carBase}/${sheet.frames[direction as keyof typeof sheet.frames].source}`} alt={`Roadster ${directionNames[direction]}`} /><span>{directionNames[direction]}</span></a>)}</div>
    </section>

    <section className="asset-section" aria-labelledby="props-heading">
      <div className="asset-section-heading"><div><span className="asset-eyebrow">02 / PROPS</span><h2 id="props-heading">障害物・小物 13種類</h2></div><a href={`${propBase}/roadster_race_props.zip`}>一式ZIPをダウンロード ↗</a></div>
      <p className="asset-section-note">各カードの左が斜め視点、右が見下ろし視点です。GLBも個別に開けます。</p>
      <div className="asset-prop-grid">{props.map(item => <article className="asset-prop" key={item.id}><div className="asset-prop-images"><a href={`${propBase}/${item.sprite}`}><img loading="lazy" src={`${propBase}/${item.sprite}`} alt={`${item.label}の斜め視点`} /><small>斜め視点</small></a><a href={`${propBase}/${item.top}`}><img loading="lazy" src={`${propBase}/${item.top}`} alt={`${item.label}の見下ろし視点`} /><small>見下ろし</small></a></div><div className="asset-prop-footer"><div><h3>{item.label}</h3><span>{item.id}</span></div><a href={`${propBase}/${item.glb}`}>GLB ↗</a></div></article>)}</div>
    </section>
  </main>;
}
