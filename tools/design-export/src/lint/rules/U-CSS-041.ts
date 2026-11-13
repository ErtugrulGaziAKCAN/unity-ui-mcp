import { parseShadow, splitShadows } from "../../bake/shadow.js";
import { layoutOf, type Layout } from "../layout.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

interface Rect { x0: number; y0: number; x1: number; y1: number }

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
const SIDES = ["top", "right", "bottom", "left"];
const PAINT_TAGS = new Set(["img", "input", "textarea", "select", "svg"]);
const MOVES = ["transform", "translate", "rotate", "scale"];

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

/** How far a translate moves the element (x, y), in CSS px; 0 for other transforms (their own rules bound them). */
function translateBy(value: string): [number, number] {
  const v = value.trim();
  if (!v || v === "none") return [0, 0];
  const parts = v.split(/\s+/);
  return [px(parts[0] ?? "0"), px(parts[1] ?? "0")];
}

/** Layers in which the element is a CSS stacking context or positioned: what makes CSS paint it after in-flow elements. */
function stackingLayers(L: Layout, i: number): string[] {
  const out = new Set<string>();
  for (const prop of [...MOVES, "opacity", "position"]) {
    for (const c of L.layerCands(i, prop)) {
      const v = c.entry.value.trim();
      const stacks = prop === "opacity" ? Number(v) < 1 : prop === "position" ? v === "relative" || v === "absolute" : v !== "none";
      if (stacks) out.add(c.dims.join("+"));
    }
  }
  return [...out].sort();
}

/**
 * A layer that turns a static element into a CSS stacking context (a transform, translate, rotate, scale or opacity on
 * :hover, a class or a screen state) makes CSS paint the element and its box-shadow after every in-flow element of the
 * screen; UI Toolkit keeps painting in hierarchy order, so where its shadow (or the translated box) reaches an element
 * that comes later in the markup, CSS shows the shadow on top and UI Toolkit underneath. U-CSS-032 covers siblings whose
 * boxes overlap in the base style; this covers the other layers and what the shadow reaches.
 */
export const rule: Rule = {
  id: "U-CSS-041", severity: "error",
  check(s: DomSnapshot) {
    const L = layoutOf(s);
    const c = new Collector();
    const els = s.elements;
    const ancestorOf = (a: number, b: number) => { for (let x = els[b].parent; x >= 0; x = els[x].parent) if (x === a) return true; return false; };
    // in flow and no stacking context in the base style (a later element's own hover does not hold while this one is hovered)
    const plain = (i: number) => L.inScreen(i) && L.position(i) === "static" && !MOVES.some((p) => (els[i].computed[p] ?? "none") !== "none")
      && !(Number(els[i].computed.opacity ?? "1") < 1);
    for (const e of els) {
      if (!L.inScreen(e.index) || !e.box || L.position(e.index) !== "static" || L.visibleDisplay(e.index) === "none") continue;
      const layers = stackingLayers(L, e.index);
      if (!layers.length) continue;
      // the element's reach in any layer: its box, moved by a translate, widened by its outer shadows
      const reach: [number, number, number, number] = [0, 0, 0, 0];
      let dx = 0, dy = 0;
      for (const cand of [...L.layerCands(e.index, "box-shadow"), { entry: { value: e.computed["box-shadow"] ?? "none" } }]) {
        shadowReach(cand.entry.value).forEach((v, k) => { reach[k] = Math.max(reach[k], v); });
      }
      for (const cand of L.layerCands(e.index, "translate")) { const [x, y] = translateBy(cand.entry.value); dx = Math.max(dx, Math.abs(x)); dy = Math.max(dy, Math.abs(y)); }
      const b = e.box;
      const area: Rect = { x0: b.x - reach[0] - dx, y0: b.y - reach[1] - dy, x1: b.x + b.w + reach[2] + dx, y1: b.y + b.h + reach[3] + dy };
      const hits: string[] = [];
      for (const f of els) {
        if (f.index <= e.index || ancestorOf(e.index, f.index) || !paints(f) || !f.box || !plain(f.index)) continue;
        // inside a later stacking context or positioned ancestor: that one paints after the element in both
        let contained = false;
        for (let x = f.parent; x >= 0 && !contained; x = els[x].parent) if (x !== e.index && L.inScreen(x) && !plain(x) && !ancestorOf(x, e.index)) contained = true;
        if (contained) continue;
        const fb = f.box;
        const ox = Math.min(area.x1, fb.x + fb.w) - Math.max(area.x0, fb.x), oy = Math.min(area.y1, fb.y + fb.h) - Math.max(area.y0, fb.y);
        if (ox > 0.5 && oy > 0.5) hits.push(L.name(f.index));
        if (hits.length >= 3) break;
      }
      if (hits.length) {
        c.add(e.path, `${L.name(e.index)} becomes a stacking context in ${layers.map((k) => k || "the base style").join(", ")} (CSS then paints it and its shadow after the in-flow elements), ` +
          `and what it paints reaches ${hits.join(", ")}, which come later in the markup: UI Toolkit paints ${hits.length > 1 ? "them" : "it"} on top`);
      }
    }
    return c.findings(rule,
      "Keep a moved, faded or shadowed state from reaching later elements: give the element room (a margin at least its shadow's reach), " +
      "or position: relative on it in every layer (and on the elements it reaches, so the markup order decides as in UI Toolkit), or change the state without a transform.");
  },
};
