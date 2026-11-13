import { parseShadow, splitShadows } from "../../bake/shadow.js";
import { layoutOf, type Layout } from "../layout.js";
import { cssPaintsAbove, unityPaintOrder, type PaintSibling } from "../paint-order.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { siblingConflicts } from "./U-CSS-032.js";
import { Collector } from "./util.js";

interface Rect { x0: number; y0: number; x1: number; y1: number }

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
const SIDES = ["top", "right", "bottom", "left"];
const PAINT_TAGS = new Set(["img", "input", "textarea", "select", "svg"]);
const MOVES = ["transform", "translate", "rotate", "scale"];
/** The properties that decide where CSS paints an element and how far it reaches. */
const PROPS = [...MOVES, "opacity", "position", "box-shadow"];

/** The element draws something of its own (text, an image or control, a background, a border, a shadow). */
function paints(e: SnapElement): boolean {
  if (!e.rendered || !e.box || e.computed.visibility === "hidden") return false;
  const k = e.computed;
  return e.texts.length > 0 || PAINT_TAGS.has(e.tag) || !TRANSPARENT.test(k["background-color"] ?? "") || (k["background-image"] ?? "none") !== "none" ||
    SIDES.some((sd) => (k[`border-${sd}-width`] ?? "0px") !== "0px") || (k["box-shadow"] ?? "none") !== "none";
}

const px = (v: string) => { const m = /^(-?[\d.]+)px$/.exec(v.trim()); return m ? Number(m[1]) : 0; };

/** How far an element's outer box-shadows reach past its border box (left, top, right, bottom), in CSS px. */
function shadowReach(value: string): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (const item of splitShadows(value).outer) {
    try {
      const p = parseShadow(item, {});
      const r = p.blur + p.spread;
      out[0] = Math.max(out[0], r - p.ox); out[1] = Math.max(out[1], r - p.oy);
      out[2] = Math.max(out[2], r + p.ox); out[3] = Math.max(out[3], r + p.oy);
    } catch { /* U-CSS-014 reports a shadow that cannot be baked */ }
  }
  return out;
}

/**
 * How far a `translate` value or the translate functions of a `transform` move the element (x, y), in CSS px; 0 for
 * other transforms (their own rules bound them).
 */
function translateBy(prop: string, value: string): [number, number] {
  const v = value.trim();
  if (!v || v === "none") return [0, 0];
  if (prop === "translate") { const parts = v.split(/\s+/); return [px(parts[0] ?? "0"), px(parts[1] ?? "0")]; }
  if (prop !== "transform") return [0, 0];
  let x = 0, y = 0;
  for (const m of v.matchAll(/translate(x|y|3d)?\(([^)]*)\)/gi)) {
    const args = m[2].split(",").map((a) => px(a));
    const kind = (m[1] ?? "").toLowerCase();
    if (kind === "x") x += args[0] ?? 0;
    else if (kind === "y") y += args[0] ?? 0;
    else { x += args[0] ?? 0; y += args[1] ?? 0; }
  }
  return [x, y];
}

/** One style layer of an element: its key ("" for the base style) and the values PROPS take there. */
interface LayerValues { key: string; get(prop: string): string }

/** The base style and every layer that changes one of PROPS on the element. */
function layersOf(L: Layout, i: number): LayerValues[] {
  const e = L.s.elements[i];
  const base = (prop: string) => e.computed[prop] ?? (prop === "opacity" ? "1" : prop === "position" ? "static" : "none");
  const keys = new Set<string>();
  for (const prop of PROPS) for (const c of L.layerCands(i, prop)) keys.add(c.dims.join("+"));
  return [{ key: "", get: base }, ...[...keys].sort().map((key) => ({
    key,
    get: (prop: string) => L.layerCands(i, prop).find((c) => c.dims.join("+") === key)?.entry.value ?? base(prop),
  }))];
}

/**
 * Hover shadows and moved states over later elements, for static and positioned elements alike. CSS paints an element
 * that is positioned or a stacking context (a transform, translate, rotate, scale or opacity, in the base style or in a
 * layer: :hover, a class, a screen state), with its box-shadow, after the in-flow elements of its stacking context
 * (CSS 2.1 appendix E); UI Toolkit paints in hierarchy order, as the compiler orders siblings. For every element and
 * layer, both orders against each later painting element its box, translate or outer shadow reaches come from the shared
 * paint-order module (paint-order.ts): CSS's between the two elements' participants in their closest common stacking
 * context, UI Toolkit's between their ancestors under the closest common parent. Boxes that overlap in the base style
 * where the siblings already differ are U-CSS-032's.
 */
export const rule: Rule = {
  id: "U-CSS-041", severity: "error",
  check(s: DomSnapshot) {
    const L = layoutOf(s);
    const c = new Collector();
    const els = s.elements;
    const chain = (i: number) => { const out: number[] = []; for (let x = i; x >= 0; x = els[x].parent) out.push(x); return out; };
    const flexItem = (i: number) => els[i].parent >= 0 && L.visibleDisplay(els[i].parent) === "flex";
    const posOf = (i: number, v: LayerValues | null) => (v ? v.get("position") : L.position(i)).trim();
    const positioned = (i: number, v: LayerValues | null) => /^(relative|absolute)$/.test(posOf(i, v));
    const isolating = (i: number, v: LayerValues | null) => {
      const get = (p: string) => (v ? v.get(p) : els[i].computed[p] ?? "none").trim();
      return Number(get("opacity")) < 1 || MOVES.some((p) => get(p) !== "none" && get(p) !== "");
    };
    /** Creates a stacking context: positioned (or a flex item) with a z-index, or isolating. */
    const context = (i: number, v: LayerValues | null) => isolating(i, v) || (L.zIndex(i) !== null && (positioned(i, v) || flexItem(i)));
    /** The paint record of an element (null: an in-flow element that paints in tree order). */
    const record = (i: number, v: LayerValues | null): PaintSibling => {
      const pos = posOf(i, v), z = L.zIndex(i);
      const position = pos === "absolute" ? "absolute" : pos === "relative" || (flexItem(i) && z !== null) ? "relative" : "static";
      return { index: i, name: L.name(i), position, z: position === "static" ? null : z, isolates: isolating(i, v) };
    };
    /**
     * The participant of `i` in the stacking context `under` (exclusive): its outermost ancestor-or-self below it that
     * creates a stacking context, else its nearest positioned or isolating one, else itself as in-flow content.
     */
    const participant = (i: number, under: number, own: LayerValues | null): PaintSibling => {
      let outer: number | null = null, near: number | null = null;
      for (let x = i; x >= 0 && x !== under; x = els[x].parent) {
        const v = x === i ? own : null;
        if (context(x, v)) outer = x;
        if (near === null && (positioned(x, v) || isolating(x, v))) near = x;
      }
      const p = outer ?? near;
      return p === null ? { index: i, name: L.name(i), position: "static", z: null, isolates: false } : record(p, p === i ? own : null);
    };
    const unityCache = new Map<number, Map<number, number> | null>();
    /** UI Toolkit's paint position of each compiled child of `p` (the compiler's sibling order), null when it rejects them. */
    const unityAt = (p: number) => {
      if (!unityCache.has(p)) {
        const kids = L.children(p).filter((k) => L.inScreen(k));
        const sibs: PaintSibling[] = kids.map((k) => ({ index: k, name: L.name(k), position: L.position(k) as PaintSibling["position"], z: L.zIndex(k) }));
        const r = sibs.every((x) => ["static", "relative", "absolute"].includes(x.position)) ? unityPaintOrder(sibs, L.visibleDisplay(p) === "flex") : null;
        unityCache.set(p, r?.ok ? new Map(r.order.map((k, n) => [k, n])) : null);
      }
      return unityCache.get(p)!;
    };
    const conflicts = new Set(siblingConflicts(s).map((x) => `${Math.min(x.top, x.under)},${Math.max(x.top, x.under)}`));
    const overlaps = (a: Rect, b: { x: number; y: number; w: number; h: number }) =>
      Math.min(a.x1, b.x + b.w) - Math.max(a.x0, b.x) > 0.5 && Math.min(a.y1, b.y + b.h) - Math.max(a.y0, b.y) > 0.5;

    for (const e of els) {
      if (!L.inScreen(e.index) || !e.box || L.visibleDisplay(e.index) === "none" || !paints(e)) continue;
      const above: string[] = [], hits: string[] = [];
      const up = chain(e.index), upSet = new Set(up);
      const layers = layersOf(L, e.index), base = layers[0];
      for (const v of layers) {
        // what the element paints in this layer: its box, moved by a translate, widened by its outer shadows
        const reach = shadowReach(v.get("box-shadow"));
        // the snapshot's box already holds the base style's transforms; a layer moves it by the difference
        const moved = (w: LayerValues) => MOVES.slice(0, 2).map((p) => translateBy(p, w.get(p))).reduce((a, b) => [a[0] + b[0], a[1] + b[1]]);
        const [tx, ty] = v.key === "" ? [0, 0] : [moved(v)[0] - moved(base)[0], moved(v)[1] - moved(base)[1]];
        const b = e.box;
        const area: Rect = { x0: b.x - reach[0] + Math.min(0, tx), y0: b.y - reach[1] + Math.min(0, ty), x1: b.x + b.w + reach[2] + Math.max(0, tx), y1: b.y + b.h + reach[3] + Math.max(0, ty) };
        const own: Rect = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
        for (const f of els) {
          if (f.index <= e.index || upSet.has(f.index) || !L.inScreen(f.index) || !paints(f) || !f.box || !overlaps(area, f.box)) continue;
          const fUp = chain(f.index);
          if (fUp.includes(e.index)) continue; // inside the element: painted with it in both
          const lca = fUp.find((x) => upSet.has(x))!;
          const a = up[up.indexOf(lca) - 1], bb = fUp[fUp.indexOf(lca) - 1];
          // the closest common stacking context (or positioned ancestor) holds both participants
          const sc = up.slice(up.indexOf(lca)).find((x) => context(x, null) || positioned(x, null)) ?? -1;
          const css = cssPaintsAbove(participant(e.index, sc, v), participant(f.index, sc, null));
          const order = unityAt(lca);
          if (!order || !order.has(a) || !order.has(bb)) continue;
          const unity = order.get(a)! > order.get(bb)!;
          if (css === unity) continue;
          // boxes that overlap in the base style where the siblings already differ: U-CSS-032 reports them
          if (v.key === "" && conflicts.has(`${Math.min(a, bb)},${Math.max(a, bb)}`) && overlaps(own, f.box)) continue;
          if (!above.includes(v.key)) above.push(v.key);
          if (!hits.includes(L.name(f.index)) && hits.length < 3) hits.push(L.name(f.index));
        }
      }
      if (hits.length) {
        c.add(e.path, `${L.name(e.index)} paints after the in-flow elements in CSS in ${above.map((k) => k || "the base style").join(", ")} (it is positioned or a stacking context there), ` +
          `and what it paints (its box, translate or shadow) reaches ${hits.join(", ")}, which come later in the markup: UI Toolkit paints ${hits.length > 1 ? "them" : "it"} on top`);
      }
    }
    return c.findings(rule,
      "Keep a positioned, moved, faded or shadowed element from reaching later elements: give it room (a margin at least its shadow's reach), " +
      "or position: relative on the later elements it reaches too (in the base style), so the markup order decides as in UI Toolkit, or change the state without a transform.");
  },
};
