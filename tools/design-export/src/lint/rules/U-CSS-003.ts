import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-003", severity: "error",
  check(s) {
    const out = [];
    for (const r of s.rules) for (const sel of r.selectors) {
      if (!sel.structural.length) continue;
      const hit = (sel.elements ?? []).filter((i) => !isExternal(s, i) && !nonDesign(s)[i]);
      if (!hit.length) continue;
      out.push(make(rule, s.elements[hit[0]].path,
        `selector "${sel.text}" uses :${sel.structural.join(", :")} and matches ${hit.length} element${hit.length > 1 ? "s" : ""} [${r.path}]`,
        "Style the element with a class instead of a position- or content-dependent selector; for alternating rows put a class on each written-out row."));
    }
    return out;
  },
};
