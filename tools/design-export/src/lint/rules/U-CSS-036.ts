import { cssSupport } from "../allowed-css.js";
import { layoutOf } from "../layout.js";
import { px } from "../css-values.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

const BOX = ["padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"];

/** content-box on an element with a width or height and padding or border: UI Toolkit sizes the border box (the kit's border-box). */
export const rule: Rule = {
  id: "U-CSS-036", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    for (const e of s.elements) {
      if (!L.inScreen(e.index) || e.ns !== "html") continue;
      const cands = L.cands(e.index);
      const contentBox = e.computed["box-sizing"] === "content-box" || cands.some((x) => x.prop === "box-sizing" && x.entry.value.trim() === "content-box");
      if (!contentBox) continue;
      const sized = cands.filter((x) => (x.prop === "width" || x.prop === "height") && x.entry.value.trim() !== "auto").map((x) => x.prop);
      const extras = BOX.filter((p) => (px(e.computed[p]) ?? 0) !== 0 || cands.some((x) => x.prop === p && x.dims.length > 0 && (px(x.entry.value) ?? 0) > 0));
      if (!sized.length || !extras.length) continue;
      c.add(e.path, `box-sizing: content-box with ${Array.from(new Set(sized)).join(" and ")} and ${extras.map((p) => p.replace(/-(top|right|bottom|left)/, "")).filter((v, i, a) => a.indexOf(v) === i).join(" and ")}: UI Toolkit sizes the border box`);
    }
    return c.findings(rule, `${cssSupport.fixFor("box-sizing")} Set box-sizing: border-box (for example *, *::before, *::after { box-sizing: border-box }) and give the width or height of the border box.`);
  },
};
