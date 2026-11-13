import { StyleExtractor, type Cand } from "../extract/styles.js";
import { PSEUDO_STATES } from "../extract/layers.js";
import { designChildren } from "./repeat.js";
import type { DomSnapshot, SnapElement } from "./snapshot.js";
import { inSvg, isExternal, nonDesign } from "./rules/util.js";

/**
 * What the Unity lowering reads from a node, seen from the lint: the default render's computed values stand for the
 * base layer (the IR's base is the default state at the reference viewport) and the IR extraction's own cascade
 * gives the layers that differ (hover, states, breakpoints, ancestor states). Shared by the rules that mirror a
 * lowering decision (U-CSS-004, U-CSS-032 to U-CSS-036).
 */
export interface Layout {
  readonly s: DomSnapshot;
  /** The IR extraction's cascade over the snapshot (layers, effective values, transitions). */
  readonly ex: StyleExtractor;
  /** Elements of the compiled screen: inside the screen root, not external, not script/style, not inside an inline SVG. */
  inScreen(i: number): boolean;
  /** Design children of an element that compile to nodes (no line breaks, inline SVG roots included). */
  children(i: number): number[];
  /** Base position, as the lowering reads it (fixed and sticky are U-CSS-017's). */
  position(i: number): string;
  /** Base z-index; null for auto. */
  zIndex(i: number): number | null;
  /** The one visible display (flex or block, blockified), or none when no layer shows the element. */
  visibleDisplay(i: number): "flex" | "block" | "none";
  /** Declarations of a property in layers other than base (their layer dimensions in `dims`); empty when unknown. */
  layerCands(i: number, prop: string): Cand[];
  /** Every candidate declaration reaching the element (base and layers); empty when the cascade cannot be read. */
  cands(i: number): Cand[];
  /** Index of the element an `anc(<id>):…` dimension names, or -1. */
  ancestorOf(dim: string): number;
  /** A short name for messages: the data-u-id or the last path segment. */
  name(i: number): string;
}

const memo = new WeakMap<DomSnapshot, Layout>();

const BLOCKIFY: Record<string, "flex" | "block" | "none"> = {
  flex: "flex", "inline-flex": "flex", none: "none", block: "block", "inline-block": "block", inline: "block", "list-item": "block", "flow-root": "block",
};

export function layoutOf(s: DomSnapshot): Layout {
  const hit = memo.get(s);
  if (hit) return hit;
  const ids = new Map(s.elements.map((e) => [e.index, `x${e.index}`]));
  const ex = new StyleExtractor(s, { ids });
  const root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
  const inside = s.elements.map(() => false);
  for (const e of s.elements) inside[e.index] = e.index === root || (e.parent >= 0 && inside[e.parent]);
  const candCache = new Map<number, Cand[]>();
  const cands = (i: number): Cand[] => {
    let c = candCache.get(i);
    if (!c) {
      try { c = ex.cands(i).filter((x) => !x.prop.startsWith("--")); } catch { c = []; }
      candCache.set(i, c);
    }
    return c;
  };
  const el = (i: number): SnapElement => s.elements[i];
  const layout: Layout = {
    s, ex,
    inScreen: (i) => inside[i] && !isExternal(s, i) && !nonDesign(s)[i] && !(inSvg(s)[i] && el(i).tag !== "svg"),
    children: (i) => designChildren(s, el(i)),
    position: (i) => el(i).computed.position || "static",
    zIndex: (i) => {
      const z = (el(i).computed["z-index"] ?? "auto").trim();
      return z === "auto" || z === "" ? null : Number(z);
    },
    visibleDisplay: (i) => {
      const values = [el(i).computed.display, ...cands(i).filter((c) => c.prop === "display" && c.dims.length).map((c) => c.entry.value.trim())];
      for (const v of values) { const d = BLOCKIFY[v] ?? "block"; if (d !== "none") return d; }
      return "none";
    },
    layerCands: (i, prop) => cands(i).filter((c) => c.prop === prop && c.dims.length > 0),
    cands,
    ancestorOf: (dim) => { const m = /^anc\(x(\d+)\)/.exec(dim); return m ? Number(m[1]) : -1; },
    name: (i) => {
      const e = el(i);
      return e.attrs["data-u-id"] !== undefined ? `'${e.attrs["data-u-id"]}'` : e.path.split(" > ").pop()!;
    },
  };
  memo.set(s, layout);
  return layout;
}

/** An own pseudo-state or own is-* class dimension (`hover`, `class:is-open`), as opposed to ancestors, states and breakpoints. */
export const ownStateDim = (d: string) => PSEUDO_STATES.has(d) || d.startsWith("class:");
