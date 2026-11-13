import { splitTopLevel } from "../lint/css-values.js";

/** Name of an element without data-u-id: its parent's id and its position among the parent's IR children. */
export function structuralId(parentId: string, index: number): string {
  return `${parentId}__${index}`;
}

/** IR token key of a custom property: the name without its leading `--` (`--color-surface` → `color-surface`). */
export const tokenKey = (customProperty: string): string => customProperty.replace(/^--/, "");

/** Number text with at most 6 decimals, no trailing zeros, no -0. */
export function fmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

export interface Breakpoint { name: string; minWidth?: number; maxWidth?: number; minAspect?: number; maxAspect?: number }

const FEATURES = ["min-width", "max-width", "min-aspect-ratio", "max-aspect-ratio"] as const;
type Feature = (typeof FEATURES)[number];
const FIELD: Record<Feature, keyof Omit<Breakpoint, "name">> = {
  "min-width": "minWidth", "max-width": "maxWidth", "min-aspect-ratio": "minAspect", "max-aspect-ratio": "maxAspect",
};

function lengthPx(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(px|em|rem)$/i.exec(v.trim());
  if (!m) return null;
  return m[2].toLowerCase() === "px" ? Number(m[1]) : Number(m[1]) * 16; // media em/rem use the initial font size
}

function ratio(v: string): { value: number; text: string } | null {
  const p = v.split("/").map((x) => x.trim());
  const n = p.map(Number);
  if (p.length > 2 || n.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  return { value: p.length === 2 ? n[0] / n[1] : n[0], text: p.join("-") };
}

/**
 * The breakpoint a rule's enclosing media conditions (outermost first) describe, or null when they set no feature
 * (`screen`, `all`). The name is derived from the bounds (`max-width-1919`, `min-width-1280_max-width-1919`,
 * `min-aspect-ratio-16-9`). Throws for what a breakpoint class cannot express (lists, other features, `not`).
 */
export function breakpointOf(conditions: string[]): Breakpoint | null {
  const bounds = new Map<Feature, { value: number; text: string }>();
  for (const cond of conditions) {
    const list = splitTopLevel(cond, ",");
    if (list.length > 1) throw new Error(`@media ${cond}: a media query list (comma) cannot become one breakpoint; write one @media per breakpoint`);
    let rest = cond.toLowerCase();
    for (const m of cond.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+)\)/gi)) {
      const f = m[1].toLowerCase() as Feature;
      if (!FEATURES.includes(f)) throw new Error(`@media ${cond}: feature ${f} cannot become a breakpoint`);
      const v = f.endsWith("width") ? ((x) => (x === null ? null : { value: x, text: fmt(x) }))(lengthPx(m[2])) : ratio(m[2]);
      if (!v) throw new Error(`@media ${cond}: value "${m[2].trim()}" of ${f} is not supported`);
      const prev = bounds.get(f);
      // nested conditions: the stricter bound wins
      if (!prev || (f.startsWith("min") ? v.value > prev.value : v.value < prev.value)) bounds.set(f, v);
      rest = rest.replace(m[0].toLowerCase(), " ");
    }
    const words = rest.split(/\s+/).filter(Boolean).filter((w) => !["only", "screen", "all", "and"].includes(w));
    if (words.length) throw new Error(`@media ${cond}: "${words.join(" ")}" cannot become a breakpoint`);
  }
  if (bounds.size === 0) return null;
  const bp: Breakpoint = { name: "" };
  const parts: string[] = [];
  for (const f of FEATURES) {
    const b = bounds.get(f);
    if (!b) continue;
    bp[FIELD[f]] = b.value;
    parts.push(`${f}-${b.text}`);
  }
  bp.name = parts.join("_");
  return bp;
}
