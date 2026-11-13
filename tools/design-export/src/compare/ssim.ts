/**
 * The pinned SSIM of the fidelity comparison (spec §15, findings §11; reference: `spike/m0-metrics.ts`):
 *
 * - non-overlapping 8×8 blocks of the 8-px grid on BT.601 luma (`0.299 R + 0.587 G + 0.114 B`),
 *   `C1 = (0.01·255)²`, `C2 = (0.03·255)²`, sample variance (n − 1); blocks that do not fit the image are left out;
 * - copy-mask: before comparing, masked pixels of the second image (text boxes inflated by 2 px, `data-u-external`
 *   regions) are replaced by the first image's;
 * - a capture's SSIM is the mean over all blocks; a region's (an element box joined with its shadow rect) the mean over
 *   the blocks that overlap its bounding box.
 *
 * The block values are computed once per capture (`blockSsimMap`); every region is a mean over that map, so the
 * per-element SSIMs cost almost nothing on top of the whole-capture one.
 */
import type { Rgba } from "../bake/png.js";

export interface Rect { x: number; y: number; w: number; h: number }

/** One SSIM value per full 8×8 block, row-major (`cols × rows`). */
export interface BlockMap { cols: number; rows: number; values: Float64Array }

const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

/**
 * Marks the pixels of every rect, grown by `inflate` px on each side, in a `w × h` mask (1 = excluded). Rounding as in
 * the reference: from floor(start − inflate) to ceil(end + inflate), clipped to the image.
 */
export function maskRects(w: number, h: number, rects: Iterable<Rect>, inflate = 2, mask: Uint8Array = new Uint8Array(w * h)): Uint8Array {
  for (const r of rects) {
    const y0 = Math.max(0, Math.floor(r.y - inflate)), y1 = Math.min(h, Math.ceil(r.y + r.h + inflate));
    const x0 = Math.max(0, Math.floor(r.x - inflate)), x1 = Math.min(w, Math.ceil(r.x + r.w + inflate));
    if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
  }
  return mask;
}

/** Block SSIM of `a` and `b` (same size), with `b`'s masked pixels taken from `a`. */
export function blockSsimMap(a: Rgba, b: Rgba, mask: Uint8Array | null): BlockMap {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`images differ in size: ${a.w}×${a.h} and ${b.w}×${b.h}`);
  const cols = Math.floor(a.w / 8), rows = Math.floor(a.h / 8), w = a.w;
  const values = new Float64Array(cols * rows);
  const ya = new Float64Array(64), yb = new Float64Array(64);
  const da = a.data, db = b.data;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let i = 0, ma = 0, mb = 0;
      for (let y = r * 8; y < r * 8 + 8; y++) {
        for (let x = c * 8; x < c * 8 + 8; x++, i++) {
          const p = y * w + x, o = p * 4;
          const la = 0.299 * da[o] + 0.587 * da[o + 1] + 0.114 * da[o + 2];
          const lb = mask !== null && mask[p] ? la : 0.299 * db[o] + 0.587 * db[o + 1] + 0.114 * db[o + 2];
          ya[i] = la; yb[i] = lb;
          ma += la; mb += lb;
        }
      }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let k = 0; k < 64; k++) {
        const pa = ya[k] - ma, pb = yb[k] - mb;
        va += pa * pa; vb += pb * pb; cov += pa * pb;
      }
      va /= 63; vb /= 63; cov /= 63;
      values[r * cols + c] = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    }
  }
  return { cols, rows, values };
}

/** Mean block SSIM over the blocks that overlap the rect's bounding box; NaN when no full block does. */
export function regionSsim(map: BlockMap, r: Rect): number {
  const c0 = Math.max(0, Math.floor(r.x / 8)), c1 = Math.min(map.cols, Math.ceil((r.x + r.w) / 8));
  const r0 = Math.max(0, Math.floor(r.y / 8)), r1 = Math.min(map.rows, Math.ceil((r.y + r.h) / 8));
  let s = 0, n = 0;
  for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) { s += map.values[y * map.cols + x]; n++; }
  return n ? s / n : NaN;
}

/** Mean of every block: the whole-capture SSIM. */
export function wholeSsim(map: BlockMap): number {
  return regionSsim(map, { x: 0, y: 0, w: map.cols * 8, h: map.rows * 8 });
}

/**
 * Whole-image copy-mask SSIM: `mask` 1 = excluded (text boxes inflated by 2 px, external regions); excluded pixels
 * of `b` are copied from `a` before the comparison.
 */
export function ssimMasked(a: Rgba, b: Rgba, mask: Uint8Array): number {
  return wholeSsim(blockSsimMap(a, b, mask));
}

/** Union bounding box of two rects. */
export const unionRect = (p: Rect, q: Rect): Rect => {
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
  return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y };
};
