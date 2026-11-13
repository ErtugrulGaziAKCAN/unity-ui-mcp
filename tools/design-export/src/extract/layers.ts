import { overlap, type Breakpoint } from "../lint/resolve/media.js";

/**
 * Layer keys (R39). A key is `base` or dimensions joined with `+` in canonical order bp → state → class → anc → own
 * pseudo-state (alphabetical within a kind):
 *   bp:<name> | state:<name> | class:<is-x> | anc(<ancestor id>):<pseudo | class:is-x> | hover|active|focus|disabled|checked
 * e.g. `state:loading+hover`, `anc(card):hover`, `bp:narrow+anc(row):class:is-selected`. A layer applies while all its
 * dimensions hold; animation triggers use the same keys (`show` for base).
 */

export const PSEUDO_STATES = new Set(["hover", "active", "focus", "disabled", "checked"]);
export type DimKind = "bp" | "state" | "class" | "anc" | "pseudo";
const RANK: Record<DimKind, number> = { bp: 0, state: 1, class: 2, anc: 3, pseudo: 4 };

export function dimKind(d: string): DimKind {
  if (d.startsWith("bp:")) return "bp";
  if (d.startsWith("state:")) return "state";
  if (d.startsWith("class:")) return "class";
  if (d.startsWith("anc(")) return "anc";
  return "pseudo";
}

/** Canonical key of a set of dimensions ("base" when empty). */
export function keyOf(dims: Iterable<string>): string {
  const list = Array.from(new Set(dims));
  if (!list.length) return "base";
  return list.sort((a, b) => RANK[dimKind(a)] - RANK[dimKind(b)] || (a < b ? -1 : a > b ? 1 : 0)).join("+");
}

export const dimsOf = (key: string): string[] => (key === "base" ? [] : key.split("+"));
export const subset = (a: readonly string[], b: readonly string[]) => a.every((d) => b.includes(d));
export const union = (a: readonly string[], b: readonly string[]) => Array.from(new Set([...a, ...b]));

/** Whether all dimensions can hold at once: one screen state at a time, overlapping breakpoint ranges. */
export function satisfiable(dims: readonly string[], breakpoints: ReadonlyMap<string, Breakpoint>): boolean {
  if (dims.filter((d) => d.startsWith("state:")).length > 1) return false;
  const bps = dims.filter((d) => d.startsWith("bp:")).map((d) => breakpoints.get(d.slice(3)));
  for (let i = 0; i < bps.length; i++) for (let j = i + 1; j < bps.length; j++) {
    const a = bps[i], b = bps[j];
    if (a && b && !overlap(a, b)) return false;
  }
  return true;
}

/**
 * An ancestor's own layer dimensions as seen from a descendant: its pseudo-states and is-* classes become
 * `anc(<id>):…`; states, breakpoints and its own anc dimensions are unchanged. Null when the ancestor has no IR id
 * and owns pseudo-state or class dimensions.
 */
export function toDescendant(dims: readonly string[], ancestorId: string | undefined): string[] | null {
  const out: string[] = [];
  for (const d of dims) {
    const k = dimKind(d);
    if (k === "pseudo" || k === "class") {
      if (!ancestorId) return null;
      out.push(`anc(${ancestorId}):${d}`);
    } else out.push(d);
  }
  return out;
}

/**
 * A descendant's layer dimensions as they apply to one of its ancestors: `anc(<that id>):x` becomes the ancestor's
 * own `x`, the descendant's own pseudo-states and classes do not apply to it, the rest is unchanged.
 */
export function toAncestor(dims: readonly string[], ancestorId: string | undefined): string[] {
  const out: string[] = [];
  const prefix = ancestorId ? `anc(${ancestorId}):` : null;
  for (const d of dims) {
    const k = dimKind(d);
    if (k === "pseudo" || k === "class") continue;
    if (prefix && d.startsWith(prefix)) out.push(d.slice(prefix.length));
    else out.push(d);
  }
  return out;
}

/** Animation trigger of a layer: its key, `show` for base. */
export const triggerOf = (layer: string) => (layer === "base" ? "show" : layer);
