import { splitTopLevel } from "../css-values.js";

/**
 * Border-radius resolution (CSS Backgrounds 3 §5.5): each corner's horizontal radius is resolved against the box
 * width and its vertical radius against the height, then, when adjacent radii on a side add up to more than that
 * side, every radius is scaled by the smallest factor f = min(side / sum). Shared by lint (U-CSS-020) and the IR
 * lowering, which writes one px radius per corner.
 */

export type Corner = "top-left" | "top-right" | "bottom-right" | "bottom-left";
export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-right", "bottom-left"];
export const cornerProperty = (c: Corner) => `border-${c}-radius`;

export interface Radius { x: number; y: number }
export type Radii = Record<Corner, Radius>;
export interface Box { w: number; h: number }
export interface LengthContext { fontSize?: number; rootFontSize?: number }

/** One length-percentage → px against `basis`; null when it cannot be resolved without layout (calc, viewport units…). */
export function lengthPx(v: string, basis: number, ctx: LengthContext = {}): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%|em|rem)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "": return n === 0 ? 0 : null;
    case "px": return n;
    case "%": return (n / 100) * basis;
    case "em": return ctx.fontSize === undefined ? null : n * ctx.fontSize;
    case "rem": return n * (ctx.rootFontSize ?? 16);
  }
  return null;
}

/** A longhand corner value ("10px", "10px 20px", "50%") → [horizontal, vertical]; vertical repeats horizontal when omitted. */
export function parseCornerRadius(value: string): [string, string] | null {
  const parts = splitTopLevel(value.trim(), " ");
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1]];
  return null;
}

/** The `border-radius` shorthand ("a [b [c [d]]] [/ e [f [g [h]]]]") → the four longhand values "h v". */
export function expandBorderRadius(value: string): Record<Corner, string> | null {
  const halves = splitTopLevel(value, "/");
  if (halves.length > 2) return null;
  const four = (s: string): string[] | null => {
    const p = splitTopLevel(s, " ");
    if (p.length < 1 || p.length > 4) return null;
    const [a, b = a, c = a, d = b] = p;
    return [a, b, c, d];
  };
  const h = four(halves[0]);
  const v = halves.length === 2 ? four(halves[1]) : h;
  if (!h || !v) return null;
  const out = {} as Record<Corner, string>;
  CORNERS.forEach((c, i) => { out[c] = h[i] === v[i] ? h[i] : `${h[i]} ${v[i]}`; });
  return out;
}

/**
 * Resolves corner values (longhand syntax; missing corners are 0) to px for a border box, applying the
 * overlapping-curves factor. Null when a value cannot be resolved.
 */
export function resolveRadii(corners: Partial<Record<Corner, string>>, box: Box, ctx: LengthContext = {}): Radii | null {
  const r = {} as Radii;
  for (const c of CORNERS) {
    const v = corners[c];
    if (v === undefined || v.trim() === "") { r[c] = { x: 0, y: 0 }; continue; }
    const p = parseCornerRadius(v);
    if (!p) return null;
    const x = lengthPx(p[0], box.w, ctx), y = lengthPx(p[1], box.h, ctx);
    if (x === null || y === null || x < 0 || y < 0) return null;
    // a zero on either axis draws a square corner (CSS Backgrounds 3 §5.1)
    r[c] = x === 0 || y === 0 ? { x: 0, y: 0 } : { x, y };
  }
  const ratios = [
    [box.w, r["top-left"].x + r["top-right"].x],
    [box.w, r["bottom-left"].x + r["bottom-right"].x],
    [box.h, r["top-left"].y + r["bottom-left"].y],
    [box.h, r["top-right"].y + r["bottom-right"].y],
  ].filter(([, sum]) => sum > 0).map(([side, sum]) => side / sum);
  const f = Math.min(1, ...ratios);
  if (f < 1) for (const c of CORNERS) r[c] = { x: r[c].x * f, y: r[c].y * f };
  return r;
}

/** Corners whose horizontal and vertical radii differ by more than `tolerance` px (UI Toolkit draws circular corners only). */
export function ellipticalCorners(r: Radii, tolerance = 0.5): Corner[] {
  return CORNERS.filter((c) => Math.abs(r[c].x - r[c].y) > tolerance);
}
