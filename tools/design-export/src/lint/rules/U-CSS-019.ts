import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The design relies on CSS's automatic minimum size of flex items, which UI Toolkit treats as 0. */
export const rule: Rule = {
  id: "U-CSS-019", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (!e.minAuto || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const k = e.minAuto.axis === "row" ? "w" : "h";
      const before = e.minAuto.before[k], after = e.minAuto.after[k];
      if (before - after <= 0.01) continue;
      const prop = e.minAuto.axis === "row" ? "min-width" : "min-height";
      out.push(make(rule, e.path, `${prop}: auto keeps the ${e.minAuto.axis === "row" ? "width" : "height"} at ${r2(before)} px; with ${prop}: 0 (UI Toolkit) it is ${r2(after)} px`,
        `Give the item an explicit ${prop} in px, or flex-shrink: 0, or make the container large enough; UI Toolkit treats ${prop}: auto as 0 and breaks long words instead.`));
    }
    return out;
  },
};
