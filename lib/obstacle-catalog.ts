import manifest from "../public/roadster-circuit/props/manifest.json" with { type: "json" };

const PREFIX = "/roadster-circuit/props/";

/** Asset URLs are taken only from the checked-in manifest, never from user input. */
export const OBSTACLE_ASSETS = manifest.filter(asset => asset.kind === "obstacle").map(asset => ({
  ...asset,
  glbUrl: `${PREFIX}${asset.glb}`,
  spriteUrl: `${PREFIX}${asset.sprite}`,
  topUrl: `${PREFIX}${asset.top}`,
}));

export type ObstacleAsset = (typeof OBSTACLE_ASSETS)[number];

export function getObstacleAsset(id: unknown): ObstacleAsset | undefined {
  return typeof id === "string" ? OBSTACLE_ASSETS.find(asset => asset.id === id) : undefined;
}
