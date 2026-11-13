/**
 * Colour samples for the comparison: shift-tolerant ΔE2000 at a point, the ring points of an element (background
 * just inside its border, the border itself, and its corners for the radius shape) and the ink of a text line.
 *
 * Every sample takes the Unity colour at the same place of the element (each side's own box) and the best of the
 * Unity colours offset by up to 1 px, so the ±1 px box allowance cannot make a sample fail; a wrong colour, border or
 * corner shape covers more than one pixel and still does.
 */
import type { Rgba } from "../bake/png.js";
import { deltaE2000 } from "./color.js";
import type { Rect } from "./ssim.js";

export type Rgb3 = [number, number, number];

/** Mean colour of a `win`×`win` window (1 or 3) centred on (x, y), clipped to the image. */
export function sampleAt(img: Rgba, x: number, y: number, win: number): Rgb3 {
  const r = win >> 1;
  const x0 = Math.max(0, x - r), x1 = Math.min(img.w - 1, x + r), y0 = Math.max(0, y - r), y1 = Math.min(img.h - 1, y + r);
  let R = 0, G = 0, B = 0, n = 0;
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const o = (yy * img.w + xx) * 4;
    R += img.data[o]; G += img.data[o + 1]; B += img.data[o + 2]; n++;
  }
  if (!n) { const o = (Math.min(img.h - 1, Math.max(0, y)) * img.w + Math.min(img.w - 1, Math.max(0, x))) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; }
  return [R / n, G / n, B / n];
}

/** ΔE2000 of the design at (gx, gy) against the closest Unity colour at (ux, uy) offset by up to 1 px. */
export function bestDeltaE(gp: Rgba, gx: number, gy: number, up: Rgba, ux: number, uy: number, win: number): { de: number; a: Rgb3; b: Rgb3 } {
  const a = sampleAt(gp, gx, gy, win);
  let best = { de: Infinity, a, b: a };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const b = sampleAt(up, ux + dx, uy + dy, win), de = deltaE2000(a, b);
    if (de < best.de) best = { de, a, b };
  }
  return best;
}

export type RingKind = "edge" | "border" | "corner";
/** A ring sample: where on the element (for the report), its pixel on each side and the window size. */
export interface RingPoint { where: string; kind: RingKind; gx: number; gy: number; ux: number; uy: number; win: number }

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNER_DEPTHS = [2, 4, 7, 11, 16];

/**
 * Ring points of an element whose design box is `g` and Unity box `u`, each placed relative to its own box:
 * - `edge`: the background just inside the border (inset border + 3 px) at ¼, ½ and ¾ of each side, 3×3 means;
 * - `border`: the middle of each painted border side, at half its width (single pixels under 3 px);
 * - `corner`: along each corner's diagonal at 2, 4, 7, 11 and 16 px (within half the smaller side), 3×3 means, which
 *   tell a pill from a rounded rectangle or a square corner.
 */
export function ringPoints(g: Rect, u: Rect, border: readonly number[] | undefined, kinds: readonly RingKind[]): RingPoint[] {
  const bw = border ?? [0, 0, 0, 0];
  const out: RingPoint[] = [];
  const L = (b: Rect) => Math.floor(b.x), T = (b: Rect) => Math.floor(b.y), R = (b: Rect) => Math.ceil(b.x + b.w) - 1, B = (b: Rect) => Math.ceil(b.y + b.h) - 1;
  const minSide = Math.min(g.w, g.h, u.w, u.h);
  const add = (where: string, kind: RingKind, win: number, at: (b: Rect) => [number, number]) => {
    const [gx, gy] = at(g), [ux, uy] = at(u);
    out.push({ where, kind, gx, gy, ux, uy, win });
  };
  if (kinds.includes("edge")) {
    for (const f of [0.25, 0.5, 0.75]) {
      const pct = `${f * 100}%`;
      if (bw[0] + 4 < g.h / 2) add(`inside the top edge at ${pct}`, "edge", 3, (b) => [Math.floor(b.x + f * b.w), T(b) + bw[0] + 3]);
      if (bw[2] + 4 < g.h / 2) add(`inside the bottom edge at ${pct}`, "edge", 3, (b) => [Math.floor(b.x + f * b.w), B(b) - bw[2] - 3]);
      if (bw[3] + 4 < g.w / 2) add(`inside the left edge at ${pct}`, "edge", 3, (b) => [L(b) + bw[3] + 3, Math.floor(b.y + f * b.h)]);
      if (bw[1] + 4 < g.w / 2) add(`inside the right edge at ${pct}`, "edge", 3, (b) => [R(b) - bw[1] - 3, Math.floor(b.y + f * b.h)]);
    }
  }
  if (kinds.includes("border")) {
    SIDES.forEach((side, i) => {
      const w = bw[i];
      if (w < 1) return;
      const half = Math.floor(w / 2), win = w >= 3 ? 3 : 1;
      add(`${side} border`, "border", win, (b) => side === "top" ? [Math.floor(b.x + b.w / 2), T(b) + half]
        : side === "bottom" ? [Math.floor(b.x + b.w / 2), B(b) - half]
        : side === "left" ? [L(b) + half, Math.floor(b.y + b.h / 2)] : [R(b) - half, Math.floor(b.y + b.h / 2)]);
    });
  }
  if (kinds.includes("corner")) {
    for (const d of CORNER_DEPTHS) {
      if (d + 2 >= minSide / 2) break;
      add(`top-left corner, ${d} px in`, "corner", 3, (b) => [L(b) + d, T(b) + d]);
      add(`top-right corner, ${d} px in`, "corner", 3, (b) => [R(b) - d, T(b) + d]);
      add(`bottom-left corner, ${d} px in`, "corner", 3, (b) => [L(b) + d, B(b) - d]);
      add(`bottom-right corner, ${d} px in`, "corner", 3, (b) => [R(b) - d, B(b) - d]);
    }
  }
  return out;
}

/** Ink of the text in a window: background and ink colour, and the ink amount in pixels (anti-aliasing weighted). */
export interface Ink { bg: Rgb3; ink: Rgb3; coverage: number }

const luma = (d: Uint8Array, o: number) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
function medianOf(hist: Uint32Array, n: number): number {
  let acc = 0;
  for (let v = 0; v < hist.length; v++) { acc += hist[v]; if (acc * 2 >= n) return v; }
  return hist.length - 1;
}

/**
 * The text ink inside a window (a line rect): the background is the median luma (glyphs cover well under half of a
 * line box) with its median colour; ink pixels lie on the far side of the background. The ink colour is the median of
 * the 10 % ink pixels that differ most (stem centres; robust to a stray pixel, and the same on both renderers, which
 * anti-alias differently). Coverage sums each ink-side pixel's difference relative to the ink's, capped at 1: an area
 * in pixels that grows with weight and size. Null when nothing differs from the background by 8 luma levels.
 */
export function inkIn(img: Rgba, r: Rect): Ink | null {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(img.w, Math.ceil(r.x + r.w));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(img.h, Math.ceil(r.y + r.h));
  const n = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!n) return null;
  const d = img.data, lum = new Float64Array(n), off = new Int32Array(n), lh = new Uint32Array(256);
  let i = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, i++) {
    const o = (y * img.w + x) * 4, l = luma(d, o);
    lum[i] = l; off[i] = o; lh[Math.min(255, Math.round(l))]++;
  }
  const bgL = medianOf(lh, n);
  // background colour: per-channel medians of the pixels at the background luma
  const ch = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let nb = 0, maxD = 0, sign = 1;
  for (let k = 0; k < n; k++) {
    const dl = lum[k] - bgL;
    if (Math.abs(dl) <= 2) { const o = off[k]; ch[0][d[o]]++; ch[1][d[o + 1]]++; ch[2][d[o + 2]]++; nb++; }
    if (Math.abs(dl) > maxD) { maxD = Math.abs(dl); sign = dl < 0 ? -1 : 1; }
  }
  if (maxD < 8) return null;
  const bg: Rgb3 = nb ? [medianOf(ch[0], nb), medianOf(ch[1], nb), medianOf(ch[2], nb)] : [bgL, bgL, bgL];
  const side: number[] = [];
  for (let k = 0; k < n; k++) if ((lum[k] - bgL) * sign > 2) side.push(k);
  side.sort((a, b) => (lum[b] - lum[a]) * sign);
  const top = side.slice(0, Math.max(3, Math.ceil(side.length * 0.1)));
  const ink = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const k of top) { const o = off[k]; ink[0][d[o]]++; ink[1][d[o + 1]]++; ink[2][d[o + 2]]++; }
  const inkC: Rgb3 = [medianOf(ink[0], top.length), medianOf(ink[1], top.length), medianOf(ink[2], top.length)];
  const inkD = Math.max(1, Math.abs(0.299 * inkC[0] + 0.587 * inkC[1] + 0.114 * inkC[2] - bgL));
  let coverage = 0;
  for (const k of side) coverage += Math.min(1, ((lum[k] - bgL) * sign) / inkD);
  return { bg, ink: inkC, coverage };
}
