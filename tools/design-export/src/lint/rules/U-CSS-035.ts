import { layoutOf } from "../layout.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

/**
 * UI Toolkit anchors an absolute element to its parent; CSS anchors it to the nearest positioned ancestor. The compiler
 * therefore needs a positioned parent (the screen root counts), and one position for every layer.
 */
export const rule: Rule = {
  id: "U-CSS-035", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const fixes = new Map<string, string>();
    const root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
    for (const e of s.elements) {
      if (!L.inScreen(e.index) || e.index === root) continue;
      const pos = L.position(e.index);
      const norm = (v: string) => (v === "static" ? "static" : v);
      for (const x of L.layerCands(e.index, "position")) {
        if (norm(x.entry.value.trim()) !== norm(pos)) {
          c.add(e.path, `position: ${x.entry.value.trim()} in layer ${x.key} differs from position: ${pos}`);
          fixes.set(e.path, "Keep one position in every layer; move the element with translate or insets instead.");
        }
      }
      if (pos !== "absolute" || e.parent < 0 || e.parent === root) continue;
      const parent = L.position(e.parent);
      if (parent === "relative" || parent === "absolute") continue;
      c.add(e.path, `position: absolute in ${L.name(e.parent)}, which is position: ${parent}: CSS anchors it to the nearest positioned ancestor, UI Toolkit to its parent`);
      fixes.set(e.path, `Set position: relative on the parent (${L.name(e.parent)}).`);
    }
    return c.findings(rule, (path) => fixes.get(path) ?? "Set position: relative on the parent.");
  },
};
