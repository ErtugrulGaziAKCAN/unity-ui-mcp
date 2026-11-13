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

/**
 * Where Chromium paints a box laid out at `b` (device px) at a device scale: its layout rect snapped to whole CSS px
 * (Blink snaps boxes in layout space; the device scale is applied when rastering), so at scale 0.75 a box laid out at
 * 180.996 device px (241.33 CSS px) paints from 180.75 (241 CSS px), a quarter-covered first column. UI Toolkit snaps
 * the box to whole device px instead (findings: pixel grid).
 */
export function paintedRect(b: Rect, scale: number): Rect {
  if (!(scale > 0)) return b;
  const snap = (v: number) => Math.round(Math.round(v / scale) * scale * 1e6) / 1e6;
  const x0 = snap(b.x), y0 = snap(b.y), x1 = snap(b.x + b.w), y1 = snap(b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The pixels of a border side that both renderers cover fully: Chromium paints the side from the painted rect's edge
 * at its exact device width (anti-aliased where that is fractional), UI Toolkit from its whole-pixel edge at the width
 * rounded (half up, at least 1). Returns the first and last such pixel across the side (inclusive), or null.
 */
function fullBand(gEdge: number, uEdge: number, w: number, inward: 1 | -1): [number, number] | null {
  const uw = Math.max(1, Math.round(w)), ue = Math.round(uEdge);
  const [g0, g1] = inward > 0 ? [Math.ceil(gEdge - 1e-6), Math.floor(gEdge + w + 1e-6) - 1] : [Math.ceil(gEdge - w - 1e-6), Math.floor(gEdge + 1e-6) - 1];
  const [u0, u1] = inward > 0 ? [ue, ue + uw - 1] : [ue - uw, ue - 1];
  const lo = Math.max(g0, u0), hi = Math.min(g1, u1);
  return lo <= hi ? [lo, hi] : null;
}

export type RingKind = "edge" | "border" | "corner";
/** A ring sample: where on the element (for the report), its pixel on each side and the window size. */
export interface RingPoint { where: string; kind: RingKind; gx: number; gy: number; ux: number; uy: number; win: number }

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNER_DEPTHS = [2, 4, 7, 11, 16];

/**
 * Ring points of an element whose design box is `g` and Unity box `u`, each placed relative to its own box:
 * - `edge`: the background just inside the border (inset border + 3 px) at ¼, ½ and ¾ of each side, 3×3 means;
 * - `border`: the middle of each painted border side, on the pixels both renderers cover fully (`g` is Chromium's painted
 *   rect, see paintedRect): one pixel, or a 3×3 mean where three or more are; a side neither covers fully is not sampled;
 * - `corner`: along each corner's diagonal at 2, 4, 7, 11 and 16 px (within half the smaller side), 3×3 means, which
 *   tell a pill from a rounded rectangle or a square corner; none whose mean straddles a border's inner edge.
 * With the corner radii (device px, top-left, top-right, bottom-right, bottom-left), no sample sits on a rounded
 * corner's anti-aliased edge, where Chromium's and UI Toolkit's anti-aliasing differ by a few ΔE although the shapes
 * agree: an edge point that would is moved inside the curve, and a corner point within 2 px of the curve is left out.
 * A radius that differs by 2 px or more still moves the curve across a remaining point.
 */
export function ringPoints(g: Rect, u: Rect, border: readonly number[] | undefined, kinds: readonly RingKind[], radii?: readonly number[]): RingPoint[] {
  const bw = border ?? [0, 0, 0, 0];
  const rr = (radii ?? [0, 0, 0, 0]).map((r) => Math.max(0, Math.min(r, g.w / 2, g.h / 2)));
  const out: RingPoint[] = [];
  const L = (b: Rect) => Math.floor(b.x), T = (b: Rect) => Math.floor(b.y), R = (b: Rect) => Math.ceil(b.x + b.w) - 1, B = (b: Rect) => Math.ceil(b.y + b.h) - 1;
  const minSide = Math.min(g.w, g.h, u.w, u.h);
  const add = (where: string, kind: RingKind, win: number, at: (b: Rect) => [number, number]) => {
    const [gx, gy] = at(g), [ux, uy] = at(u);
    out.push({ where, kind, gx, gy, ux, uy, win });
  };
  /** How far a corner of radius r curves in from a side, at distance `along` from that side's end (0 past the curve). */
  const curve = (r: number, along: number) => (along >= r ? 0 : r - Math.sqrt(r * r - (r - along) * (r - along)));
  /** The depth of an edge point: inside the border by 3 px, and 2 px past the curve of the nearer corner. */
  const depth = (base: number, rA: number, alongA: number, rB: number, alongB: number) => Math.ceil(Math.max(base, curve(rA, alongA) + 2, curve(rB, alongB) + 2));
  if (kinds.includes("edge")) {
    for (const f of [0.25, 0.5, 0.75]) {
      const pct = `${f * 100}%`;
      // [top-left, top-right, bottom-right, bottom-left] = rr[0..3]
      const top = depth(bw[0] + 3, rr[0], f * g.w, rr[1], (1 - f) * g.w), bottom = depth(bw[2] + 3, rr[3], f * g.w, rr[2], (1 - f) * g.w);
      const left = depth(bw[3] + 3, rr[0], f * g.h, rr[3], (1 - f) * g.h), right = depth(bw[1] + 3, rr[1], f * g.h, rr[2], (1 - f) * g.h);
      if (top + 1 < g.h / 2) add(`inside the top edge at ${pct}`, "edge", 3, (b) => [Math.floor(b.x + f * b.w), T(b) + top]);
      if (bottom + 1 < g.h / 2) add(`inside the bottom edge at ${pct}`, "edge", 3, (b) => [Math.floor(b.x + f * b.w), B(b) - bottom]);
      if (left + 1 < g.w / 2) add(`inside the left edge at ${pct}`, "edge", 3, (b) => [L(b) + left, Math.floor(b.y + f * b.h)]);
      if (right + 1 < g.w / 2) add(`inside the right edge at ${pct}`, "edge", 3, (b) => [R(b) - right, Math.floor(b.y + f * b.h)]);
    }
  }
  if (kinds.includes("border")) {
    SIDES.forEach((side, i) => {
      const w = bw[i];
      if (w < 1) return;
      const band = side === "top" ? fullBand(g.y, u.y, w, 1) : side === "bottom" ? fullBand(g.y + g.h, u.y + u.h, w, -1)
        : side === "left" ? fullBand(g.x, u.x, w, 1) : fullBand(g.x + g.w, u.x + u.w, w, -1);
      if (!band) return;
      const across = (band[0] + band[1]) >> 1, win = band[1] - band[0] + 1 >= 3 ? 3 : 1;
      add(`${side} border`, "border", win, (b) => side === "top" || side === "bottom" ? [Math.floor(b.x + b.w / 2), across] : [across, Math.floor(b.y + b.h / 2)]);
    });
  }
  if (kinds.includes("corner")) {
    // where each corner's curve crosses its diagonal, in px from the corner
    const cross = rr.map((r) => r * (1 - Math.SQRT1_2));
    for (const d of CORNER_DEPTHS) {
      if (d + 2 >= minSide / 2) break;
      const near = (k: number) => rr[k] > 0 && Math.abs(d - cross[k]) < 2;
      // nor where the 3×3 mean straddles the inner edge of a border side the corner joins: a box painted on whole CSS px
      // (Chromium) and one on whole device px (UI Toolkit) anti-alias that edge in different columns
      const inner = (...sides: number[]) => sides.some((k) => bw[k] > 0 && Math.abs(d + 0.5 - bw[k]) < 2);
      if (!near(0) && !inner(3, 0)) add(`top-left corner, ${d} px in`, "corner", 3, (b) => [L(b) + d, T(b) + d]);
      if (!near(1) && !inner(1, 0)) add(`top-right corner, ${d} px in`, "corner", 3, (b) => [R(b) - d, T(b) + d]);
      if (!near(3) && !inner(3, 2)) add(`bottom-left corner, ${d} px in`, "corner", 3, (b) => [L(b) + d, B(b) - d]);
      if (!near(2) && !inner(1, 2)) add(`bottom-right corner, ${d} px in`, "corner", 3, (b) => [R(b) - d, B(b) - d]);
    }
  }
  return out;
}

/**
 * Whether the image is flat around (x, y): every pixel of the 5×5 window within ΔE2000 `limit` of the 3×3 mean. A
 * colour sample is a background colour only where the design is flat; at an edge (a picture's detail, a curve, a line
 * of text) two renderers' anti-aliasing and resampling differ although both draw the same thing, which SSIM measures.
 */
export function flatAt(img: Rgba, x: number, y: number, limit = 3): boolean {
  const mean = sampleAt(img, x, y, 3);
  for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) {
    if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
    const o = (yy * img.w + xx) * 4;
    if (deltaE2000(mean, [img.data[o], img.data[o + 1], img.data[o + 2]]) > limit) return false;
  }
  return true;
}

/**
 * Whether pixel (x, y) lies within `margin` px of a rounded corner's curve of box `b` (device px): the outer edge of the
 * border box, or the inner edge of the border (the padding box's curve, radius minus the border). Colours there are
 * anti-aliased, and Chromium's and UI Toolkit's anti-aliasing differ by a few ΔE where the shapes agree.
 */
export function nearCurve(b: Rect, border: readonly number[] | undefined, radii: readonly number[] | undefined, x: number, y: number, margin = 2.5): boolean {
  if (!radii) return false;
  const bw = border ?? [0, 0, 0, 0];
  const px = x + 0.5, py = y + 0.5;
  // corners: [top-left, top-right, bottom-right, bottom-left]; the border sides each corner joins
  const corners: [number, number, number, number, number][] = [
    [radii[0], b.x, b.y, bw[3], bw[0]], [radii[1], b.x + b.w, b.y, bw[1], bw[0]],
    [radii[2], b.x + b.w, b.y + b.h, bw[1], bw[2]], [radii[3], b.x, b.y + b.h, bw[3], bw[2]],
  ];
  for (const [rRaw, ex, ey, sx, sy] of corners) {
    const r = Math.min(rRaw, b.w / 2, b.h / 2);
    if (!(r > 0)) continue;
    const cx = ex + (ex === b.x ? r : -r), cy = ey + (ey === b.y ? r : -r);
    // only the corner's own quadrant curves
    if ((ex === b.x ? px > cx : px < cx) || (ey === b.y ? py > cy : py < cy)) continue;
    const dx = px - cx, dy = py - cy;
    if (Math.abs(Math.hypot(dx, dy) - r) < margin) return true;
    const rx = r - sx, ry = r - sy;
    if (rx > 0 && ry > 0 && Math.abs(Math.hypot(dx / rx, dy / ry) - 1) * Math.min(rx, ry) < margin) return true;
  }
  return false;
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
