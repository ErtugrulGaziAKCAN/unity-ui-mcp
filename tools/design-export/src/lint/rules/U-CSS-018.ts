import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-018", severity: "error",
  check: (s) => declRule(s, rule,
    "Use flex-start, center or flex-end; to line up two text styles, give the smaller one a top margin equal to the difference of their baselines.",
    (d, v) => ((d.name === "align-items" || d.name === "align-self" || d.name === "align-content") && /\bbaseline\b/i.test(v) ? declText(d, v) : null), { pseudo: true }),
};
