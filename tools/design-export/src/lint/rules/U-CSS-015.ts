import { functionCalls } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-015", severity: "error",
  check: (s, kit) => {
    const allowed = new Set(kit.filterFunctions.map((f) => f.toLowerCase()));
    return declRule(s, rule,
      allowed.size ? `Use only these filter functions: ${kit.filterFunctions.join(", ")}.` : "Remove the filter: no filter function has passed the fidelity suite yet (kit.config.json filterFunctions is empty).",
      (d, v) => {
        if ((d.name !== "filter" && d.name !== "-webkit-filter") || v.trim() === "none") return null;
        const fns = functionCalls(v).map((c) => c.name);
        const bad = fns.length ? fns.filter((n) => !allowed.has(n)) : [v.trim()];
        return bad.length ? `${declText(d, v)} (${bad.join(", ")})` : null;
      }, { pseudo: true });
  },
};
