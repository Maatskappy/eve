// Generates the dot-matrix masks behind template card previews.
// Run from apps/docs: node scripts/generate-dot-matrix.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../public/templates/dot-matrix/", import.meta.url);
const GAP = 8; // px between dot centers
const W = 480; // wider than any gallery card
const H = 176; // h-44
const SEEDS = 4; // must match DOT_MATRIX_VARIANTS in template-preview.tsx

const hash = (x, y, seed) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);
/** Smooth value noise in [0, 1). */
const noise = (x, y, seed) => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
};
const clamp = (n) => Math.min(1, Math.max(0, n));

mkdirSync(OUT, { recursive: true });
for (let i = 0; i < SEEDS; i++) {
  const seed = i * 7919 + 1;
  const dots = [];
  for (let y = GAP / 2; y < H; y += GAP) {
    for (let x = GAP / 2; x < W; x += GAP) {
      // Even dots whose brightness drifts in soft patches, fading out downward.
      const n = noise(x / 56, y / 40, seed);
      const opacity = (0.12 + 0.88 * n ** 2) * clamp(1.1 - y / (H * 0.8));
      if (opacity < 0.02) continue;
      dots.push(`<circle cx="${x}" cy="${y}" r="1" fill-opacity="${+opacity.toFixed(2)}"/>`);
    }
  }
  writeFileSync(
    new URL(`${i}.svg`, OUT),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${dots.join("")}</svg>\n`,
  );
}
