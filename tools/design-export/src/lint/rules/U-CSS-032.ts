import { layoutOf } from "../layout.js";
import { cssPaintOrder, unityPaintOrder, type PaintSibling } from "../paint-order.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

interface Rect { x: number; y: number; w: number; h: number }

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
const SIDES = ["top", "right", "bottom", "left"];
const PAINT_TAGS = new Set(["img", "input", "textarea", "select", "svg"]);

/** The element draws something of its own: text, an image or control, a background, a border or a shadow. */
function paints(e: SnapElement): boolean {
  if (!e.rendered || !e.box || e.computed.visibility === "hidden") return false;
  const k = e.computed;
  return e.texts.length > 0 || PAINT_TAGS.has(e.tag) || !TRANSPARENT.test(k["background-color"] ?? "") || (k["background-image"] ?? "none") !== "none" ||
    SIDES.some((sd) => (k[`border-${sd}-width`] ?? "0px") !== "0px") || (k["box-shadow"] ?? "none") !== "none";
}

/** Painted rectangles of an element and its descendants (not into inline SVG or an element that clips). */
function painted(s: DomSnapshot, i: number, out: Rect[] = []): Rect[] {
  const e = s.elements[i];
  if (e.computed.display === "none") return out;
  if (paints(e)) out.push(e.box!);
  if (e.ns === "svg") return out;
  for (const k of e.children) painted(s, k, out);
  return out;
}

const overlap = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

/** CSS stacking context without a position: opacity below 1 or a transform. */
const isolates = (e: SnapElement) => {
  const k = e.computed;
  const op = Number(k.opacity ?? "1");
  return (Number.isFinite(op) && op < 1) || ["transform", "translate", "rotate", "scale"].some((p) => (k[p] ?? "none") !== "none");
};

const why = (e: SnapElement, sib: PaintSibling) => sib.position !== "static" ? `position: ${sib.position}${sib.z !== null ? `, z-index ${sib.z}` : ""}`
  : isolates(e) ? (Number(e.computed.opacity) < 1 ? `opacity ${e.computed.opacity}` : "a transform") : "in flow";

/** One pair of overlapping siblings UI Toolkit paints in another order than CSS: `top` paints above `under` in CSS. */
export interface SiblingConflict { top: number; under: number; topWhy: string; underWhy: string }

/** Every sibling pair U-CSS-032 reports (base style), from the shared paint-order module. */
export function siblingConflicts(s: DomSnapshot): SiblingConflict[] {
  const L = layoutOf(s);
  const out: SiblingConflict[] = [];
  for (const p of s.elements) {
    if (!L.inScreen(p.index) || p.computed.display === "none") continue;
    const kids = L.children(p.index).filter((k) => L.inScreen(k) && s.elements[k].computed.display !== "none");
    if (kids.length < 2) continue;
    const sibs: PaintSibling[] = kids.map((k) => ({ index: k, name: L.name(k), position: L.position(k) as PaintSibling["position"], z: L.zIndex(k), isolates: isolates(s.elements[k]) }));
    if (sibs.some((x) => !["static", "relative", "absolute"].includes(x.position))) continue; // U-CSS-017
    const flex = L.visibleDisplay(p.index) === "flex";
    const unity = unityPaintOrder(sibs, flex);
    if (!unity.ok) continue; // U-CSS-004
    const css = cssPaintOrder(sibs, flex);
    const at = (order: number[]) => new Map(order.map((k, n) => [k, n]));
    const u = at(unity.order), w = at(css);
    const rects = new Map(kids.map((k) => [k, painted(s, k)]));
    const by = new Map(sibs.map((x) => [x.index, x]));
    for (let a = 0; a < kids.length; a++) for (let b = a + 1; b < kids.length; b++) {
      const x = kids[a], y = kids[b];
      if ((u.get(x)! < u.get(y)!) === (w.get(x)! < w.get(y)!)) continue;
      if (!rects.get(x)!.some((r) => rects.get(y)!.some((q) => overlap(r, q)))) continue;
      const [top, under] = w.get(x)! > w.get(y)! ? [x, y] : [y, x];
      out.push({ top, under, topWhy: why(s.elements[top], by.get(top)!), underWhy: why(s.elements[under], by.get(under)!) });
    }
  }
  return out;
}

/**
 * Overlapping siblings that UI Toolkit paints in another order than CSS: the compiler keeps in-flow siblings in layout
 * order, so a relative sibling before a static one, or a static sibling that is a CSS stacking context (opacity below
 * 1, a transform) after an absolute one, paints differently where they overlap.
 */
export const rule: Rule = {
  id: "U-CSS-032", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    for (const { top, under, topWhy, underWhy } of siblingConflicts(s)) {
      c.add(s.elements[top].path, `${L.name(top)} (${topWhy}) paints above ${L.name(under)} (${underWhy}) in CSS, ` +
        `but UI Toolkit paints ${L.name(under)} above it (siblings paint in hierarchy order and in-flow siblings keep the layout order); they overlap`);
    }
    return c.findings(rule,
      "Give the overlapping siblings the same paint level so the markup order decides, as in UI Toolkit: position: relative on a faded or transformed sibling (or on the static one next to a relative sibling); or reorder the markup so the sibling on top comes later; or move them apart.");
  },
};
