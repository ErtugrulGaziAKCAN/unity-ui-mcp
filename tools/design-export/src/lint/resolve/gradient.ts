import { functionCalls, LENGTH_RE, normColor, splitTopLevel } from "../css-values.js";
import { lengthPx, type Box, type LengthContext } from "./radius.js";

/**
 * CSS linear/radial gradient geometry (CSS Images 3 §3): the gradient line (linear) or gradient ray (radial) length
 * for a box, and colour stop offsets after the CSS fix-up. Shared by lint (U-CSS-022) and the exporter's SVG gradient.
 */

export interface GradientStop { color: string; position: string | null }
export interface ParsedGradient {
  type: "linear" | "radial";
  repeating: boolean;
  /** The whole function text. */
  text: string;
  /** Direction / shape / size / position argument, or null for the default. */
  prelude: string | null;
  /** Colour stops in order; a double-position stop ("red 10% 20%") is two stops. */
  stops: GradientStop[];
  /** Transition hints (a bare position between two stops). */
  hints: string[];
}

const PRELUDE_WORD = /^(to|at|circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|left|right|top|bottom|center)$/i;
const ANGLE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)$/i;
const isPos = (t: string) => LENGTH_RE.test(t) || /^calc\(/i.test(t);

/** Every linear-/radial-gradient (repeating included) in a value, in order. */
export function findGradients(value: string): ParsedGradient[] {
  const out: ParsedGradient[] = [];
  const visit = (v: string) => {
    for (const call of functionCalls(v)) {
      const m = /^(repeating-)?(linear|radial)-gradient$/.exec(call.name);
      if (!m) { visit(call.args); continue; }
      const args = splitTopLevel(call.args, ",");
      let prelude: string | null = null;
      const first = splitTopLevel(args[0] ?? "", " ");
      if (first.length && first.every((t) => PRELUDE_WORD.test(t) || ANGLE_RE.test(t) || isPos(t))) prelude = args.shift()!.trim();
      const stops: GradientStop[] = [];
      const hints: string[] = [];
      for (const a of args) {
        const toks = splitTopLevel(a, " ");
        const positions = toks.filter(isPos);
        const color = toks.filter((t) => !isPos(t)).join(" ");
        if (!color) { hints.push(a.trim()); continue; }
        if (positions.length === 0) stops.push({ color, position: null });
        for (const p of positions) stops.push({ color, position: p });
      }
      out.push({ type: m[2] as "linear" | "radial", repeating: !!m[1], text: v.slice(call.start, call.end), prelude, stops, hints });
    }
  };
  visit(value);
  return out;
}

const deg = (n: number, unit: string) => unit === "deg" ? n : unit === "rad" ? (n * 180) / Math.PI : unit === "grad" ? n * 0.9 : n * 360;

/** Linear gradient angle in degrees (0 = towards the top, clockwise); corners depend on the box. */
export function linearAngle(prelude: string | null, box: Box): number | null {
  if (!prelude) return 180;
  const a = ANGLE_RE.exec(prelude.trim());
  if (a) return deg(Number(a[1]), a[2].toLowerCase());
  const t = splitTopLevel(prelude.toLowerCase(), " ");
  if (t[0] !== "to") return null;
  const sides = new Set(t.slice(1));
  const h = sides.has("left") ? -1 : sides.has("right") ? 1 : 0;
  const v = sides.has("top") ? -1 : sides.has("bottom") ? 1 : 0;
  if (h === 0 && v === 0) return null;
  if (v === 0) return h > 0 ? 90 : 270;
  if (h === 0) return v > 0 ? 180 : 0;
  // corner: perpendicular to the diagonal joining the two neighbouring corners, pointing into the named quadrant
  const dx = h * box.h, dy = v * box.w; // direction (H, -W) for "to top right" etc. in y-down space
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

interface Center { x: number; y: number }
function radialCenter(prelude: string | null, box: Box, ctx: LengthContext): Center | null {
  const at = prelude ? /\bat\b(.*)$/i.exec(prelude) : null;
  if (!at) return { x: box.w / 2, y: box.h / 2 };
  const t = splitTopLevel(at[1].trim().toLowerCase(), " ");
  const kwX: Record<string, number> = { left: 0, center: 0.5, right: 1 }, kwY: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };
  let x: number | null = null, y: number | null = null;
  if (t.length === 1) {
    if (t[0] in kwY && !(t[0] in kwX)) { x = box.w / 2; y = kwY[t[0]] * box.h; }
    else { x = t[0] in kwX ? kwX[t[0]] * box.w : lengthPx(t[0], box.w, ctx); y = box.h / 2; }
  } else if (t.length === 2) {
    let [a, b] = t;
    if ((a in kwY && !(a in kwX)) || (b in kwX && !(b in kwY))) [a, b] = [b, a];
    x = a in kwX ? kwX[a] * box.w : lengthPx(a, box.w, ctx);
    y = b in kwY ? kwY[b] * box.h : lengthPx(b, box.h, ctx);
  }
  return x === null || y === null ? null : { x, y };
}

/**
 * Length in px of the gradient line (linear: |W sin a| + |H cos a|) or of the gradient ray (radial: the circle's
 * radius or the ellipse's horizontal radius, by size keyword or explicit size). Null when it cannot be resolved.
 */
export function gradientLineLength(g: ParsedGradient, box: Box, ctx: LengthContext = {}): number | null {
  if (g.type === "linear") {
    const a = linearAngle(g.prelude, box);
    if (a === null) return null;
    const r = (a * Math.PI) / 180;
    return Math.abs(box.w * Math.sin(r)) + Math.abs(box.h * Math.cos(r));
  }
  const pre = (g.prelude ?? "").replace(/\bat\b.*$/i, "").trim().toLowerCase();
  const toks = pre ? splitTopLevel(pre, " ") : [];
  const lengths = toks.filter((t) => LENGTH_RE.test(t));
  const circle = toks.includes("circle") || (!toks.includes("ellipse") && lengths.length === 1);
  const c = radialCenter(g.prelude, box, ctx);
  if (!c) return null;
  if (lengths.length) return lengthPx(lengths[0], box.w, ctx);
  const size = toks.find((t) => /^(closest|farthest)-(side|corner)$/.test(t)) ?? "farthest-corner";
  const dxs = [c.x, box.w - c.x].map(Math.abs), dys = [c.y, box.h - c.y].map(Math.abs);
  const near = size.startsWith("closest");
  const dx = near ? Math.min(...dxs) : Math.max(...dxs), dy = near ? Math.min(...dys) : Math.max(...dys);
  if (circle) {
    if (size.endsWith("side")) return near ? Math.min(dx, dy) : Math.max(dx, dy);
    const corners = dxs.flatMap((x) => dys.map((y) => Math.hypot(x, y)));
    return near ? Math.min(...corners) : Math.max(...corners);
  }
  return size.endsWith("side") ? dx : dx * Math.SQRT2;
}

/**
 * Stop offsets as fractions of the gradient line after the CSS fix-up (first 0, last 1, never decreasing,
 * unpositioned runs spread evenly). A fraction is null when its position cannot be resolved.
 */
export function resolveStopOffsets(g: ParsedGradient, length: number | null, ctx: LengthContext = {}): (number | null)[] {
  const n = g.stops.length;
  const raw: (number | null | undefined)[] = g.stops.map((s) => {
    if (s.position === null) return undefined;
    if (s.position.trim().endsWith("%")) return Number(s.position.trim().slice(0, -1)) / 100;
    if (length === null || length === 0) return null;
    const p = lengthPx(s.position, length, ctx);
    return p === null ? null : p / length;
  });
  if (n === 0) return [];
  if (raw[0] === undefined) raw[0] = 0;
  if (raw[n - 1] === undefined) raw[n - 1] = 1;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (typeof v === "number") { if (v < max) raw[i] = max; else max = v; }
    else if (v === null) max = Infinity; // unknown: later comparisons cannot be trusted
  }
  for (let i = 0; i < n; i++) {
    if (raw[i] !== undefined) continue;
    let j = i;
    while (raw[j] === undefined) j++;
    const a = raw[i - 1], b = raw[j];
    for (let k = i; k < j; k++) raw[k] = typeof a === "number" && typeof b === "number" ? a + ((b - a) * (k - i + 1)) / (j - i + 1) : null;
    i = j;
  }
  return raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

export interface CloseStops { a: GradientStop; b: GradientStop; gap: number }

/** Consecutive stops with different colours closer than `minFraction` of the gradient line (hard stops included). */
export function closeStops(g: ParsedGradient, box: Box | null, minFraction = 1 / 64, ctx: LengthContext = {}): CloseStops[] {
  const len = box ? gradientLineLength(g, box, ctx) : null;
  const off = resolveStopOffsets(g, len, ctx);
  const out: CloseStops[] = [];
  for (let i = 0; i + 1 < g.stops.length; i++) {
    const a = off[i], b = off[i + 1];
    if (a === null || b === null) continue;
    if (normColor(g.stops[i].color) === normColor(g.stops[i + 1].color)) continue;
    if (b - a < minFraction - 1e-9) out.push({ a: g.stops[i], b: g.stops[i + 1], gap: b - a });
  }
  return out;
}
