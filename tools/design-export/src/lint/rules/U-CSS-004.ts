import type { Rule } from "../types.js";
import { declRule, declText, resolved } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-004", severity: "error",
  check: (s) => declRule(s, rule, "Use z-index only on position: absolute elements; order in-flow siblings in the markup instead (UI Toolkit draws in hierarchy order).",
    (d, v, src, t) => {
      if (d.name !== "z-index" || v.trim() === "auto") return null;
      const pos = src.decls.find((x) => x.name === "position");
      if (pos && resolved(s, pos.value, t.element?.index ?? null).trim() === "absolute") return null;
      const offending = src.elements.filter((i) => s.elements[i].computed.position !== "absolute");
      if (t.element && offending.length === 0) return null;
      return declText(d, v) + (offending.length ? ` on position: ${s.elements[offending[0]].computed.position}` : "");
    }),
};
