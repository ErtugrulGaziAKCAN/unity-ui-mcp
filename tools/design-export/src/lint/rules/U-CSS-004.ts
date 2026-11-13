import { cssSupport } from "../allowed-css.js";
import { layoutOf } from "../layout.js";
import { unityPaintOrder, type PaintSibling } from "../paint-order.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

/**
 * z-index exactly where the compiler can reproduce it: base layer only, and only where UI Toolkit's sibling order can
 * follow CSS's stacking order (absolute siblings move into place; in-flow siblings keep the layout order, so a relative
 * or flex item z-index must already agree with it; a static element that is not a flex item ignores z-index in CSS).
 */
export const rule: Rule = {
  id: "U-CSS-004", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      for (const d of L.layerCands(e.index, "z-index")) {
        c.add(e.path, `z-index: ${d.entry.value} in layer ${d.key} (the compiler orders siblings once, from the base layer)`);
      }
      const kids = L.children(e.index).filter((k) => L.inScreen(k));
      if (!kids.some((k) => L.zIndex(k) !== null)) continue;
      const sibs: PaintSibling[] = kids.map((k) => ({ index: k, name: L.name(k), position: L.position(k) as PaintSibling["position"], z: L.zIndex(k) }))
        .filter((x) => x.position === "static" || x.position === "relative" || x.position === "absolute");
      const r = unityPaintOrder(sibs, L.visibleDisplay(e.index) === "flex");
      if (!r.ok) c.add(s.elements[r.elements[0]].path, r.problem);
    }
    return c.findings(rule, cssSupport.fixFor("z-index"));
  },
};
