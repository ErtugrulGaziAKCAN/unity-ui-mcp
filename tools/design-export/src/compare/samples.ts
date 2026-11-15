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
 * `bestDeltaE` over only the window pixels a predicate keeps on both sides (`keep(x, y, design)`): the means of the kept
 * pixels of the design's window and of Unity's at its best offset of up to 1 px among the offsets that keep at least
 * `minKept` pixels, and how many that offset keeps. `de` is NaN (and `kept` 0) when no offset keeps that many.
 */
export function bestDeltaEKept(gp: Rgba, gx: number, gy: number, up: Rgba, ux: number, uy: number, win: number,
                               keep: (x: number, y: number, design: boolean) => boolean, minKept = 1): { de: number; kept: number } {
  const r = win >> 1;
  const at = (img: Rgba, x: number, y: number): Rgb3 | null => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
    const o = (y * img.w + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  };
  let best = { de: NaN, kept: 0 };
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const a = [0, 0, 0], b = [0, 0, 0];
    let n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const gxx = gx + dx, gyy = gy + dy, uxx = ux + ox + dx, uyy = uy + oy + dy;
      if (!keep(gxx, gyy, true) || !keep(uxx, uyy, false)) continue;
      const pa = at(gp, gxx, gyy), pb = at(up, uxx, uyy);
      if (!pa || !pb) continue;
      for (let k = 0; k < 3; k++) { a[k] += pa[k]; b[k] += pb[k]; }
      n++;
    }
    if (!n || n < minKept) continue;
    const de = deltaE2000(a.map((v) => v / n), b.map((v) => v / n));
    if (!(de >= best.de)) best = { de, kept: n };
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
 * A border side across its edge: the pixel at the centre of the band the renderer paints (Chromium from the painted
 * rect's edge at the exact device width, anti-aliased where that is fractional; UI Toolkit from its whole-pixel edge at
 * the width rounded half up, at least 1) and the first and last pixel it covers fully (inclusive).
 */
function sideBand(edge: number, w: number, inward: 1 | -1): { centre: number; full: [number, number] } {
  const centre = Math.floor(edge + (inward * w) / 2 + 1e-6);
  const full: [number, number] = inward > 0 ? [Math.ceil(edge - 1e-6), Math.floor(edge + w + 1e-6) - 1] : [Math.ceil(edge - w - 1e-6), Math.floor(edge + 1e-6) - 1];
  return { centre, full };
}

export type RingKind = "edge" | "border" | "corner";
/** A ring sample: where on the element (for the report), its pixel on each side and the window size. */
export interface RingPoint { where: string; kind: RingKind; gx: number; gy: number; ux: number; uy: number; win: number }

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNER_DEPTHS = [2, 4, 7, 11, 16];

/**
 * Ring points of an element whose design box is `g` and Unity box `u`, each placed relative to its own box:
 * - `edge`: the background just inside the border (inset border + 3 px) at ¼, ½ and ¾ of each side, 3×3 means;
 * - `border`: the middle of each painted border side, across it at the centre of the band each renderer paints (`g` is
 *   Chromium's painted rect, see paintedRect; its centre pixel is fully covered for any border of 2 device px or more):
 *   one pixel, or a 3×3 mean where that stays on fully covered pixels on both sides; every side is sampled;
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
      if (!(w > 0)) return;
      const inward = side === "top" || side === "left" ? 1 : -1;
      const edge = (b: Rect) => (side === "top" ? b.y : side === "bottom" ? b.y + b.h : side === "left" ? b.x : b.x + b.w);
      const gb = sideBand(edge(g), w, inward), ub = sideBand(Math.round(edge(u)), Math.max(1, Math.round(w)), inward);
      // a 3×3 mean only where it stays on fully covered pixels across the side on both renderers
      const fits = (s: ReturnType<typeof sideBand>) => s.centre - 1 >= s.full[0] && s.centre + 1 <= s.full[1];
      const win = fits(gb) && fits(ub) ? 3 : 1;
      const horizontal = side === "top" || side === "bottom";
      out.push({ where: `${side} border`, kind: "border", win,
        gx: horizontal ? Math.floor(g.x + g.w / 2) : gb.centre, gy: horizontal ? gb.centre : Math.floor(g.y + g.h / 2),
        ux: horizontal ? Math.floor(u.x + u.w / 2) : ub.centre, uy: horizontal ? ub.centre : Math.floor(u.y + u.h / 2) });
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

/**
 * Ink of the text in a window: background and ink colour, the ink amount in pixels (anti-aliasing weighted), the ink's
 * horizontal extent (`left` and `right`: where the weighted ink of the columns reaches half a pixel from each side,
 * sub-pixel, in image px) and its column profile (`columns[i]`: the weighted ink of image column `x0 + i`).
 */
export interface Ink {
  bg: Rgb3; ink: Rgb3; coverage: number; left: number; right: number; columns: Float64Array; x0: number;
  /** The ink-side pixels' luma distances from the background, largest first (`dists[0]`: the most covered pixel). */
  dists: Float64Array;
  /**
   * The sum over the ink-side pixels of (pixel − background), in sRGB values (0–255): the ink's colour direction from the
   * background, whatever share of a pixel the glyphs cover (the renderers blend glyph coverage in sRGB, so a pixel's difference
   * from the background points the same way at any coverage; ruling R138).
   */
  dirSrgb: Rgb3;
  /** Each ink-side pixel's column, row and weight (the weight as in `columns`): where the ink sits in two dimensions. */
  pixels: { x: Int32Array; y: Int32Array; w: Float64Array };
}

/** Half a pixel of ink: where an ink extent starts, counted from each side. */
const EDGE_INK = 0.5;

const luma = (d: Uint8Array, o: number) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
function medianOf(hist: Uint32Array, n: number): number {
  let acc = 0;
  for (let v = 0; v < hist.length; v++) { acc += hist[v]; if (acc * 2 >= n) return v; }
  return hist.length - 1;
}

/** A background whose fitted luma changes less than this across the window counts as flat (its median). */
const BG_PLANE_MIN = 1;
/** Pixels within this many luma levels of the background model are background (also the ink threshold). */
const BG_BAND = 2;

/**
 * The background's luma at each pixel of a window when it varies across the window: a plane `l = a + b·x + c·y` fitted
 * by least squares to the pixels within BG_BAND of the model, starting from the window's median and refitted four times
 * (glyphs and other regions fall out of the band). A box shadow or a gradient under the text changes the background by
 * a few levels across a line (a dialog's shadow: 43 to 47 luma levels over 25 rows of a card), so pixels of the same
 * background at one end of the window lay more than BG_BAND from the median and counted as ink: a column of faint
 * "ink" at the far end of the line moved its ink extent by several pixels in one renderer and not in the other, whose
 * shadow is a level weaker there. Null (the median stands) when the plane changes by less than BG_PLANE_MIN across the
 * window, or when it explains fewer pixels than the median does (two flat regions: a card's edge in the window).
 */
function backgroundPlane(lum: Float64Array, off: Int32Array, n: number, imgW: number, median: number): ((k: number) => number) | null {
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let mx = 0, my = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const p = off[k] / 4, x = p % imgW, y = Math.floor(p / imgW);
    xs[k] = x; ys[k] = y; mx += x; my += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  mx /= n; my /= n;
  let a = median, b = 0, c = 0;
  const model = (k: number) => a + b * (xs[k] - mx) + c * (ys[k] - my);
  for (let it = 0; it < 4; it++) {
    let s = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sl = 0, slx = 0, sly = 0;
    for (let k = 0; k < n; k++) {
      if (Math.abs(lum[k] - model(k)) > BG_BAND) continue;
      const x = xs[k] - mx, y = ys[k] - my, l = lum[k];
      s++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; sl += l; slx += l * x; sly += l * y;
    }
    if (s < 3) return null;
    // the normal equations of the plane, by Cramer's rule
    const det = s * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
    if (Math.abs(det) < 1e-9) return null;
    const na = (sl * (sxx * syy - sxy * sxy) - sx * (slx * syy - sxy * sly) + sy * (slx * sxy - sxx * sly)) / det;
    const nb = (s * (slx * syy - sxy * sly) - sl * (sx * syy - sxy * sy) + sy * (sx * sly - slx * sy)) / det;
    const nc = (s * (sxx * sly - slx * sxy) - sx * (sx * sly - slx * sy) + sl * (sx * sxy - sxx * sy)) / det;
    a = na; b = nb; c = nc;
  }
  if (Math.abs(b) * (x1 - x0) + Math.abs(c) * (y1 - y0) < BG_PLANE_MIN) return null;
  let byPlane = 0, byMedian = 0;
  for (let k = 0; k < n; k++) {
    if (Math.abs(lum[k] - model(k)) <= BG_BAND) byPlane++;
    if (Math.abs(lum[k] - median) <= BG_BAND) byMedian++;
  }
  return byPlane >= byMedian ? model : null;
}

/**
 * The text ink inside a window (a line rect): the background is the median luma (glyphs cover well under half of a
 * line box) with its median colour, or a plane fitted to it where it varies across the window (backgroundPlane: a
 * shadow or gradient under the text); ink pixels lie on the far side of the background at each pixel. The ink colour is
 * the median of the 10 % ink pixels that differ most (stem centres; robust to a stray pixel, and the same on both
 * renderers, which anti-alias differently). Coverage sums each ink-side pixel's difference relative to the ink's, capped
 * at 1: an area in pixels that grows with weight and size. Null when nothing differs from the background by 8 luma levels.
 */
export function inkIn(img: Rgba, r: Rect, hidden?: (x: number, y: number) => boolean): Ink | null {
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) throw new Error(`inkIn: the window is not finite (${r.x}, ${r.y}, ${r.w}, ${r.h})`);
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(img.w, Math.ceil(r.x + r.w));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(img.h, Math.ceil(r.y + r.h));
  const all = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!all) return null;
  // a pixel a later element hides (its opaque fill over the text) is not the text's
  const d = img.data, lum = new Float64Array(all), off = new Int32Array(all), lh = new Uint32Array(256);
  let i = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (hidden && hidden(x, y)) continue;
    const o = (y * img.w + x) * 4, l = luma(d, o);
    lum[i] = l; off[i] = o; lh[Math.min(255, Math.round(l))]++;
    i++;
  }
  const n = i;
  if (!n) return null;
  const bgL = medianOf(lh, n);
  // each pixel's distance from the background where it is (a shadow or gradient varies it across the window)
  const plane = backgroundPlane(lum, off, n, img.w, bgL);
  const dlOf = plane ? (k: number) => lum[k] - plane(k) : (k: number) => lum[k] - bgL;
  // background colour: per-channel medians of the pixels at the background luma
  const ch = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let nb = 0, maxD = 0, sign = 1;
  for (let k = 0; k < n; k++) {
    const dl = dlOf(k);
    if (Math.abs(dl) <= BG_BAND) { const o = off[k]; ch[0][d[o]]++; ch[1][d[o + 1]]++; ch[2][d[o + 2]]++; nb++; }
    if (Math.abs(dl) > maxD) { maxD = Math.abs(dl); sign = dl < 0 ? -1 : 1; }
  }
  if (maxD < 8) return null;
  const bg: Rgb3 = nb ? [medianOf(ch[0], nb), medianOf(ch[1], nb), medianOf(ch[2], nb)] : [bgL, bgL, bgL];
  const side: number[] = [];
  for (let k = 0; k < n; k++) if (dlOf(k) * sign > BG_BAND) side.push(k);
  side.sort((a, b) => (dlOf(b) - dlOf(a)) * sign);
  const top = side.slice(0, Math.max(3, Math.ceil(side.length * 0.1)));
  const ink = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const k of top) { const o = off[k]; ink[0][d[o]]++; ink[1][d[o + 1]]++; ink[2][d[o + 2]]++; }
  const inkC: Rgb3 = [medianOf(ink[0], top.length), medianOf(ink[1], top.length), medianOf(ink[2], top.length)];
  const inkD = Math.max(1, Math.abs(0.299 * inkC[0] + 0.587 * inkC[1] + 0.114 * inkC[2] - bgL));
  let coverage = 0;
  const cols = new Float64Array(x1 - x0);
  const dists = new Float64Array(side.length);
  const dirSrgb: Rgb3 = [0, 0, 0];
  const pixels = { x: new Int32Array(side.length), y: new Int32Array(side.length), w: new Float64Array(side.length) };
  side.forEach((k, j) => {
    const dl = dlOf(k) * sign;
    dists[j] = dl;
    const wgt = Math.min(1, dl / inkD);
    coverage += wgt;
    cols[(off[k] / 4) % img.w - x0] += wgt;
    pixels.x[j] = (off[k] / 4) % img.w; pixels.y[j] = Math.floor(off[k] / 4 / img.w); pixels.w[j] = wgt;
    const o = off[k];
    for (let c = 0; c < 3; c++) dirSrgb[c] += d[o + c] - bg[c];
  });
  return { bg, ink: inkC, coverage, ...extent(cols, x0), columns: cols, x0, dists, dirSrgb, pixels };
}

/** Where the columns' ink reaches `EDGE_INK` from the left and from the right, interpolated inside the column. */
function extent(cols: Float64Array, x0: number): { left: number; right: number } {
  let left = x0, right = x0 + cols.length, acc = 0;
  for (let i = 0; i < cols.length; i++) {
    if (acc + cols[i] >= EDGE_INK) { left = x0 + i + (EDGE_INK - acc) / cols[i]; break; }
    acc += cols[i];
  }
  acc = 0;
  for (let i = cols.length - 1; i >= 0; i--) {
    if (acc + cols[i] >= EDGE_INK) { right = x0 + i + 1 - (EDGE_INK - acc) / cols[i]; break; }
    acc += cols[i];
  }
  return { left, right };
}

/** The weighted ink of an image column (x in image px, the column's centre at x + 0.5), linearly between columns. */
function columnAt(ink: Ink, x: number): number {
  const i = x - ink.x0 - 0.5, f = Math.floor(i), c = ink.columns;
  const a = f >= 0 && f < c.length ? c[f] : 0, b = f + 1 >= 0 && f + 1 < c.length ? c[f + 1] : 0;
  return a + (b - a) * (i - f);
}

/**
 * How far Unity's glyphs at one end of a text line sit from the design's (image px, + to the right): the shift of Unity's
 * column profile that matches the design's best over [from, to) (the first or last em of the line's ink), each scaled to
 * the design's ink amount there, so a renderer's thicker or thinner strokes do not move it but a glyph does. Searched
 * within ±`range` px of `around` (the difference of the ink extents), coarse then in 0.02 px steps.
 */
export function endShift(design: Ink, unity: Ink, from: number, to: number, around: number, range = 2, margin = 4): number {
  const x0 = Math.floor(from) - margin, x1 = Math.ceil(to) + margin;
  let massA = 0;
  for (let x = Math.floor(from); x < Math.ceil(to); x++) massA += columnAt(design, x + 0.5);
  const err = (s: number) => {
    let massB = 0;
    for (let x = Math.floor(from); x < Math.ceil(to); x++) massB += columnAt(unity, x + 0.5 + s);
    const k = massB > 0 ? massA / massB : 1;
    let e = 0;
    for (let x = x0; x < x1; x++) { const d = columnAt(design, x + 0.5) - k * columnAt(unity, x + 0.5 + s); e += d * d; }
    return e;
  };
  let best = around, bestErr = err(around);
  for (let s = around - range; s <= around + range + 1e-9; s += 0.25) { const e = err(s); if (e < bestErr) { bestErr = e; best = s; } }
  const centre = best;
  for (let s = centre - 0.25; s <= centre + 0.25 + 1e-9; s += 0.02) { const e = err(s); if (e < bestErr) { bestErr = e; best = s; } }
  return best;
}

/**
 * An ellipsized line whose cut may differ by one grapheme (ruling R146): where Unity's ellipsis sits against the design's
 * and whether it is the design's ellipsis. `e` is the design's cut (boxes `ellipsis`, device px). Unity's ellipsis is found
 * by matching the column profile of the design's ellipsis ink (from `e.at` to the end of the line's ink) to Unity's near the
 * end of its ink (endShift, ±1 px around the ink extents' difference). Returns that shift (+: Unity keeps more), the
 * ellipsis's shape error (the profiles' L1 difference over the design's ellipsis mass, each scaled to the design's mass) and
 * its ink amount (Unity's over the design's), and the ink amount of the part both lines draw (the prefix up to the earlier
 * of the two cuts, plus the ellipsis). Null when the design has no ellipsis ink after `e.at`.
 */
/**
 * The centres of the ink blobs an ink's column profile resolves into over [a, b) (image px): its local maxima of at least
 * 0.2 of the highest column, a maximum at the range's edge only when it is higher than the column outside (the tail of
 * the glyph before is no blob), two maxima one blob unless the profile between them falls to half the lower of them; each
 * blob's centre is the mean column of its ink between the valleys (ruling R148: an ellipsis is three dots).
 */
export function inkBlobs(ink: Ink, a: number, b: number): number[] {
  const x0 = Math.floor(a), x1 = Math.ceil(b), p: number[] = [];
  for (let x = x0; x < x1; x++) p.push(Math.max(0, columnAt(ink, x + 0.5)));
  const max = Math.max(0, ...p);
  if (!(max > 0)) return [];
  const before = Math.max(0, columnAt(ink, x0 - 0.5)), after = Math.max(0, columnAt(ink, x1 + 0.5));
  const peaks: number[] = [];
  for (let i = 0; i < p.length; i++) if (p[i] >= 0.2 * max && p[i] > (i === 0 ? before : p[i - 1]) && p[i] >= (i === p.length - 1 ? after : p[i + 1])) peaks.push(i);
  for (let merged = true; merged && peaks.length > 1;) {
    merged = false;
    for (let j = 0; j + 1 < peaks.length; j++) {
      let v = Infinity;
      for (let i = peaks[j]; i <= peaks[j + 1]; i++) v = Math.min(v, p[i]);
      if (v > 0.5 * Math.min(p[peaks[j]], p[peaks[j + 1]])) { peaks.splice(p[peaks[j]] >= p[peaks[j + 1]] ? j + 1 : j, 1); merged = true; break; }
    }
  }
  const cuts = [0];
  for (let j = 0; j + 1 < peaks.length; j++) { let m = peaks[j]; for (let i = peaks[j]; i <= peaks[j + 1]; i++) if (p[i] < p[m]) m = i; cuts.push(m); }
  cuts.push(p.length);
  return peaks.map((_, j) => { let sum = 0, w = 0; for (let i = cuts[j]; i < cuts[j + 1]; i++) { sum += p[i] * (x0 + i + 0.5); w += p[i]; } return sum / w; });
}

/** The ink-weighted mean row (its centre, image px) of an ink's pixels in the columns [a, b); NaN without ink there. */
function inkRowCentre(ink: Ink, a: number, b: number): number {
  let sum = 0, w = 0;
  for (let j = 0; j < ink.pixels.w.length; j++) {
    const cx = ink.pixels.x[j] + 0.5;
    if (cx >= a && cx < b) { sum += ink.pixels.w[j] * (ink.pixels.y[j] + 0.5); w += ink.pixels.w[j]; }
  }
  return w > 0 ? sum / w : NaN;
}

/**
 * An ellipsis's dots in each render (ruling R148, below 16 device px): the blobs of the design's ellipsis advance and of
 * Unity's at `shift`, the largest difference of Unity's two gaps from the design's dot pitch (null unless both draw three),
 * and how far Unity's dots' vertical ink centre lies from the design's, each against its line's baseline (+ lower).
 */
export interface EllipsisDots { design: number; unity: number; offPitch: number | null; centre: number | null }

export function ellipsisCut(design: Ink, unity: Ink, e: { at: number; width: number }, baselines?: { design: number; unity: number }): { shift: number; shape: number; amount: number; common: number; rows: number; dots: EllipsisDots } | null {
  const from = Math.floor(e.at), to = Math.ceil(Math.max(design.right, e.at + 1));
  let massA = 0;
  for (let x = from; x < to; x++) massA += columnAt(design, x + 0.5);
  if (!(massA > 0)) return null;
  // matched on the ellipsis alone: the margin endShift gives a line's end would reach the prefix's last glyph, which Unity
  // places a grapheme earlier when it keeps one more (ruling R146), and pull the dots out of line (a pilot screen's title at
  // 1600×900: shift 2.57 against the dots' 3.3, shape 1.04)
  const shift = endShift(design, unity, e.at, to, unity.right - design.right, 1, 0);
  let massB = 0;
  for (let x = from; x < to; x++) massB += columnAt(unity, x + 0.5 + shift);
  const k = massB > 0 ? massA / massB : 0;
  let diff = 0;
  for (let x = from - 1; x < to + 1; x++) diff += Math.abs(columnAt(design, x + 0.5) - k * columnAt(unity, x + 0.5 + shift));
  // the prefix both draw: up to the earlier cut, at the same place on both sides
  const end = e.at + Math.min(0, shift);
  let preA = 0, preB = 0;
  for (let x = Math.min(design.x0, unity.x0); x < Math.floor(end); x++) { preA += columnAt(design, x + 0.5); preB += columnAt(unity, x + 0.5); }
  // the ellipsis's rows against each side's baseline (fix round 3, N9): its ink at the design's height, within a pixel
  let rows = 0;
  if (baselines) {
    const profile = (k: Ink, a: number, b: number) => {
      const out = new Map<number, number>();
      for (let j = 0; j < k.pixels.w.length; j++) {
        const cx = k.pixels.x[j] + 0.5;
        if (cx >= a && cx < b) out.set(k.pixels.y[j], (out.get(k.pixels.y[j]) ?? 0) + k.pixels.w[j]);
      }
      return out;
    };
    const ra = profile(design, from, to), rb = profile(unity, from + shift, to + shift);
    const at = (m: Map<number, number>, y: number) => { const f = Math.floor(y - 0.5), t = y - 0.5 - f; return (m.get(f) ?? 0) * (1 - t) + (m.get(f + 1) ?? 0) * t; };
    // the design's rows are whole: Unity's, moved by the baselines' difference, may fall between them, so the rows compared
    // are the whole ones around both (a fractional bound compared rows that hold no design ink: rows 1.0 for dots on the
    // same pixel rows when the baselines differ by a fraction, Chromium's 785.797 against Unity's 786)
    const ys = [...ra.keys(), ...[...rb.keys()].map((y) => y - (baselines.unity - baselines.design))];
    const lo = Math.floor(Math.min(...ys)) - 2, hi = Math.ceil(Math.max(...ys)) + 2;
    const kr = massB > 0 ? massA / massB : 0;
    rows = Infinity;
    for (let sy = -1; sy <= 1 + 1e-9; sy += 0.25) {
      let d = 0;
      for (let y = lo; y <= hi; y++) d += Math.abs((ra.get(y) ?? 0) - kr * at(rb, y + 0.5 + (baselines.unity - baselines.design) + sy));
      rows = Math.min(rows, d / massA);
    }
  }
  // the dots, structurally (ruling R148): the blobs of the ellipsis advance on each side, Unity's at the matched shift
  // a blob centred in the advance's first half pixel is the prefix's last glyph reaching past its advance, not a dot (the
  // dots' centres lie a sixth of the advance and more inside it)
  const inside = (c: number, at: number) => c >= at + 0.5 && c <= at + e.width;
  const da = inkBlobs(design, e.at, e.at + e.width + 0.5).filter((c) => inside(c, e.at));
  const db = inkBlobs(unity, e.at + shift, e.at + e.width + shift + 0.5).filter((c) => inside(c, e.at + shift));
  const pitch = da.length === 3 ? (da[2] - da[0]) / 2 : NaN;
  const offPitch = da.length === 3 && db.length === 3 ? Math.max(Math.abs(db[1] - db[0] - pitch), Math.abs(db[2] - db[1] - pitch)) : null;
  const centre = baselines
    ? (inkRowCentre(unity, e.at + shift, e.at + e.width + shift + 0.5) - baselines.unity) - (inkRowCentre(design, e.at, e.at + e.width + 0.5) - baselines.design)
    : NaN;
  const dots: EllipsisDots = { design: da.length, unity: db.length, offPitch, centre: Number.isFinite(centre) ? centre : null };
  return { shift, shape: diff / massA, amount: massB / massA, common: (preB + massB) / Math.max(preA + massA, 1e-9), rows, dots };
}

/** The colour of an image at a point between pixel centres (a pixel's centre is at x + 0.5), bilinear, clamped to the image. */
function bilinear(img: Rgba, x: number, y: number): Rgb3 {
  const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (xx: number, yy: number, k: number) => img.data[(Math.min(img.h - 1, Math.max(0, yy)) * img.w + Math.min(img.w - 1, Math.max(0, xx))) * 4 + k];
  const out: Rgb3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx, bottom = at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx;
    out[k] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

const dist3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Where `c` lies on the segment from `a` to `b` (0 at a, 1 at b, clamped) and how far it is from it (RGB). */
function onSegment(c: Rgb3, a: Rgb3, b: Rgb3): { t: number; off: number } {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t = Math.min(1, Math.max(0, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1] + (c[2] - a[2]) * d[2]) / len2));
  return { t, off: Math.hypot(c[0] - a[0] - t * d[0], c[1] - a[1] - t * d[1], c[2] - a[2] - t * d[2]) };
}

/** The least RGB distance between a border's colour and what lies outside it, and inside it, for its width to be measured. */
export const RING_WIDTH_CONTRAST = 20;
/** The step (device px) along a border's normal at which its width profile is sampled. */
const WIDTH_STEP = 0.25;

/**
 * The drawn width of a border across one point of it: along the normal `n` (unit, inward) from the outer edge `p` (device
 * px), each sample between the colour outside (`o`, 2 px out) and the ring's (`r`) counts as ring by its place on that segment,
 * each between the ring's and the colour inside (`i`, 2.5 px past the border's width `bw`) by its place on that one (the
 * nearer segment; where both are as near, the side of the border's middle decides), so the sum over the profile is the
 * border's covered width, also where an edge falls between pixels or the border is a pixel thinner. Null when the ring's
 * colour is too close to what lies outside or inside it to tell its edges (RING_WIDTH_CONTRAST).
 */
export function borderWidthAt(img: Rgba, p: readonly [number, number], n: readonly [number, number], bw: number, r: Rgb3): number | null {
  const at = (s: number) => bilinear(img, p[0] + s * n[0], p[1] + s * n[1]);
  const o = at(-2), i = at(bw + 2.5);
  if (dist3(r, o) < RING_WIDTH_CONTRAST || dist3(r, i) < RING_WIDTH_CONTRAST) return null;
  let width = 0;
  for (let s = -2; s <= bw + 2.5 + 1e-9; s += WIDTH_STEP) {
    const c = at(s), outer = onSegment(c, o, r), inner = onSegment(c, r, i);
    const useOuter = Math.abs(outer.off - inner.off) < 2 ? s < bw / 2 : outer.off < inner.off;
    width += (useOuter ? outer.t : 1 - inner.t) * WIDTH_STEP;
  }
  return width;
}

/** A border's drawn width at one place on both renderers (device px): `where` as the ring samples name it. */
export interface WidthPoint { where: string; design: number; unity: number }

/**
 * The drawn width of an element's border on both renderers: at the middle of each side of BORDER_SAMPLE_PX or more and, on a
 * rounded corner whose two sides are as wide and whose radius holds the border, across its curve at 45°, each on its own box
 * (the design's `g`, Unity's `u`). The ring's colour is the design's at the middle of a side (its centre pixel, fully covered
 * for a side of 2 device px or more), the same for both, so a thinner ring in Unity counts as thinner. `skip(x, y)`: a
 * design pixel the profile may not cross (text, a later element). Points whose edges cannot be told apart are left out.
 */
export function borderWidths(gp: Rgba, g: Rect, up: Rgba, u: Rect, border: readonly number[], radii: readonly number[] | undefined,
                             minSide: number, skip?: (x: number, y: number) => boolean): WidthPoint[] {
  const out: WidthPoint[] = [];
  const crosses = (b: Rect, p: readonly [number, number], n: readonly [number, number], bw: number) => {
    if (!skip) return false;
    for (let s = -3; s <= bw + 3.5; s += 0.5) if (skip(Math.floor(p[0] + s * n[0]), Math.floor(p[1] + s * n[1]))) return true;
    return false;
  };
  const ring: (Rgb3 | null)[] = [null, null, null, null];
  SIDES.forEach((side, k) => {
    const bw = border[k];
    if (!(bw >= minSide)) return;
    const place = (b: Rect): { p: [number, number]; n: [number, number] } => side === "top" ? { p: [Math.floor(b.x + b.w / 2) + 0.5, b.y], n: [0, 1] }
      : side === "bottom" ? { p: [Math.floor(b.x + b.w / 2) + 0.5, b.y + b.h], n: [0, -1] }
      : side === "left" ? { p: [b.x, Math.floor(b.y + b.h / 2) + 0.5], n: [1, 0] } : { p: [b.x + b.w, Math.floor(b.y + b.h / 2) + 0.5], n: [-1, 0] };
    const pg = place(g), pu = place(u);
    if (crosses(g, pg.p, pg.n, bw)) return;
    // the ring's colour: the design's pixel at the middle of the side's band
    const mid = [pg.p[0] + (bw / 2) * pg.n[0], pg.p[1] + (bw / 2) * pg.n[1]];
    const o = (Math.min(gp.h - 1, Math.max(0, Math.floor(mid[1]))) * gp.w + Math.min(gp.w - 1, Math.max(0, Math.floor(mid[0])))) * 4;
    const r: Rgb3 = [gp.data[o], gp.data[o + 1], gp.data[o + 2]];
    ring[k] = r;
    const design = borderWidthAt(gp, pg.p, pg.n, bw, r), unity = borderWidthAt(up, pu.p, pu.n, bw, r);
    if (design !== null && unity !== null) out.push({ where: `${side} border`, design, unity });
  });
  if (radii) {
    // corners [top-left, top-right, bottom-right, bottom-left], with the sides [vertical, horizontal] each joins
    const corners: [string, number, number, number, number, number][] = [["top-left", 0, 3, 0, -1, -1], ["top-right", 1, 1, 0, 1, -1], ["bottom-right", 2, 1, 2, 1, 1], ["bottom-left", 3, 3, 2, -1, 1]];
    for (const [name, k, vs, hs, sx, sy] of corners) {
      const bw = border[hs];
      if (!(bw >= minSide) || Math.abs(border[vs] - bw) > 1e-3) continue;
      const r = ring[hs] ?? ring[vs];
      if (!r || (ring[hs] && ring[vs] && dist3(ring[hs]!, ring[vs]!) >= RING_WIDTH_CONTRAST)) continue;
      const place = (b: Rect): { p: [number, number]; n: [number, number] } | null => {
        const rad = Math.min(radii[k], b.w / 2, b.h / 2);
        if (!(rad >= bw + 1)) return null;
        const cx = sx < 0 ? b.x + rad : b.x + b.w - rad, cy = sy < 0 ? b.y + rad : b.y + b.h - rad;
        return { p: [cx + sx * rad * Math.SQRT1_2, cy + sy * rad * Math.SQRT1_2], n: [-sx * Math.SQRT1_2, -sy * Math.SQRT1_2] };
      };
      const pg = place(g), pu = place(u);
      if (!pg || !pu || crosses(g, pg.p, pg.n, bw)) continue;
      const design = borderWidthAt(gp, pg.p, pg.n, bw, r), unity = borderWidthAt(up, pu.p, pu.n, bw, r);
      if (design !== null && unity !== null) out.push({ where: `${name} corner`, design, unity });
    }
  }
  return out;
}
