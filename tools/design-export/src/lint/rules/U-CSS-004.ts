import { cssSupport } from "../allowed-css.js";
import { layoutOf } from "../layout.js";
import { unityPaintOrder, type PaintSibling } from "../paint-order.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

const ORDER_FIX = "UI Toolkit paints siblings in markup order and the compiler moves only absolute siblings, so an absolute " +
  "sibling must fit between the in-flow siblings where CSS paints it (after the static ones, before the positioned ones it is " +
  "under): give the static sibling position: relative too, remove position: relative from the in-flow sibling before it, or " +
  "reorder the markup.";

/**
 * Sibling orders the compiler can reproduce, exactly as it checks them (Lowering.PaintOrder), with or without z-index:
 * a z-index only in the base layer; in-flow siblings keep the layout order, so a relative or flex item z-index must
 * already agree with it, and a static element that is not a flex item ignores z-index in CSS; every absolute sibling
 * needs a gap among the in-flow siblings that gives it its CSS stacking level (an absolute sibling before a relative
 * sibling that precedes a static one has none).
 */
export const rule: Rule = {
  id: "U-CSS-004", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const fixes = new Map<string, Set<string>>();
    const add = (path: string, detail: string, fix: string) => { c.add(path, detail); fixes.set(path, (fixes.get(path) ?? new Set()).add(fix)); };
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      for (const d of L.layerCands(e.index, "z-index")) {
        add(e.path, `z-index: ${d.entry.value} in layer ${d.key} (the compiler orders siblings once, from the base layer)`, cssSupport.fixFor("z-index"));
      }
      // every compiled child, hidden ones included (the compiler keeps them in the tree)
      const kids = L.children(e.index).filter((k) => L.inScreen(k));
      if (kids.length < 2 && !kids.some((k) => L.zIndex(k) !== null)) continue;
      const sibs: PaintSibling[] = kids.map((k) => ({ index: k, name: L.name(k), position: L.position(k) as PaintSibling["position"], z: L.zIndex(k) }))
        .filter((x) => x.position === "static" || x.position === "relative" || x.position === "absolute");
      const r = unityPaintOrder(sibs, L.visibleDisplay(e.index) === "flex");
      if (r.ok) continue;
      const withZ = r.elements.some((k) => L.zIndex(k) !== null && L.zIndex(k) !== 0);
      add(s.elements[r.elements[0]].path, r.problem, withZ ? cssSupport.fixFor("z-index") : ORDER_FIX);
    }
    return c.findings(rule, (path) => Array.from(fixes.get(path) ?? [cssSupport.fixFor("z-index")]).join(" "));
  },
};
