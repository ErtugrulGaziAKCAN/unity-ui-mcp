import { splitTopLevel } from "../css-values.js";

/**
 * @media conditions → breakpoint classes. Shared by lint (U-CSS-012) and the IR extraction, so a condition lint
 * accepts always becomes breakpoints. A media query list (commas) is an OR: each query becomes its own breakpoint
 * and the rule applies in each, which is equivalent because the same declarations apply whichever query matches.
 */

export interface Breakpoint { name: string; minWidth?: number; maxWidth?: number; minAspect?: number; maxAspect?: number }
export class MediaError extends Error {}

const FEATURES = ["min-width", "max-width", "min-aspect-ratio", "max-aspect-ratio"] as const;
type Feature = (typeof FEATURES)[number];
type Bound = { value: number; text: string };
const FIELD: Record<Feature, keyof Omit<Breakpoint, "name">> = {
  "min-width": "minWidth", "max-width": "maxWidth", "min-aspect-ratio": "minAspect", "max-aspect-ratio": "maxAspect",
};
const fmt = (n: number) => { const r = Math.round(n * 1e6) / 1e6; return String(Object.is(r, -0) ? 0 : r); };

function lengthPx(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(px|em|rem)$/i.exec(v.trim());
  if (!m) return null;
  return m[2].toLowerCase() === "px" ? Number(m[1]) : Number(m[1]) * 16; // media em/rem use the initial font size
}

function ratio(v: string): Bound | null {
  const p = v.split("/").map((x) => x.trim());
  const n = p.map(Number);
  if (p.length > 2 || n.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  return { value: p.length === 2 ? n[0] / n[1] : n[0], text: p.join("-") };
}

/** One media query (no commas) → its bounds. */
function parseQuery(q: string, cond: string): Map<Feature, Bound> {
  const bounds = new Map<Feature, Bound>();
  let rest = q.toLowerCase();
  for (const m of q.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+)\)/gi)) {
    const f = m[1].toLowerCase() as Feature;
    if (!FEATURES.includes(f)) throw new MediaError(`@media ${cond}: feature ${f} cannot become a breakpoint`);
    const px = f.endsWith("width") ? lengthPx(m[2]) : null;
    const v = f.endsWith("width") ? (px === null ? null : { value: px, text: fmt(px) }) : ratio(m[2]);
    if (!v) throw new MediaError(`@media ${cond}: value "${m[2].trim()}" of ${f} is not a px/em/rem length or a ratio`);
    merge(bounds, f, v);
    rest = rest.replace(m[0].toLowerCase(), " ");
  }
  const words = rest.split(/\s+/).filter(Boolean).filter((w) => !["only", "screen", "all", "and"].includes(w));
  if (words.length) throw new MediaError(`@media ${cond}: "${words.join(" ")}" cannot become a breakpoint`);
  return bounds;
}

/** Keeps the stricter bound. */
function merge(into: Map<Feature, Bound>, f: Feature, v: Bound) {
  const prev = into.get(f);
  if (!prev || (f.startsWith("min") ? v.value > prev.value : v.value < prev.value)) into.set(f, v);
}

function toBreakpoint(bounds: Map<Feature, Bound>): Breakpoint | null {
  const bp: Breakpoint = { name: "" };
  const parts: string[] = [];
  for (const f of FEATURES) {
    const b = bounds.get(f);
    if (!b) continue;
    bp[FIELD[f]] = b.value;
    parts.push(`${f}-${b.text}`);
  }
  if (!parts.length) return null;
  if ((bp.minWidth ?? 0) > (bp.maxWidth ?? Infinity) || (bp.minAspect ?? 0) > (bp.maxAspect ?? Infinity)) return null; // never matches
  bp.name = parts.join("_");
  return bp;
}

/**
 * The breakpoints a rule's enclosing media conditions (outermost first) describe: `always` when some alternative
 * sets no feature (`screen`, `all`, no @media), else one breakpoint per satisfiable alternative (none: the rule never
 * applies). Names derive from the bounds (`max-width-1919`, `min-width-1280_max-width-1919`, `min-aspect-ratio-16-9`).
 * Throws MediaError for conditions a breakpoint class cannot express.
 */
export function breakpointsOf(conditions: string[]): { always: boolean; breakpoints: Breakpoint[] } {
  let alts: Map<Feature, Bound>[] = [new Map()];
  for (const cond of conditions) {
    const queries = splitTopLevel(cond, ",").map((q) => parseQuery(q, cond));
    const next: Map<Feature, Bound>[] = [];
    for (const a of alts) for (const q of queries) {
      const m = new Map(a);
      for (const [f, v] of q) merge(m, f, v);
      next.push(m);
    }
    alts = next;
  }
  if (alts.some((a) => a.size === 0)) return { always: true, breakpoints: [] };
  const out = new Map<string, Breakpoint>();
  for (const a of alts) { const bp = toBreakpoint(a); if (bp) out.set(bp.name, bp); }
  return { always: false, breakpoints: Array.from(out.values()) };
}

/** Two breakpoints can be active at the same time (their ranges overlap). */
export function overlap(a: Breakpoint, b: Breakpoint): boolean {
  return Math.max(a.minWidth ?? 0, b.minWidth ?? 0) <= Math.min(a.maxWidth ?? Infinity, b.maxWidth ?? Infinity)
    && Math.max(a.minAspect ?? 0, b.minAspect ?? 0) <= Math.min(a.maxAspect ?? Infinity, b.maxAspect ?? Infinity);
}
