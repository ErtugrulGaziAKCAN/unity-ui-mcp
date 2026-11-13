import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-018", severity: "error",
  check: (s) => declRule(s, rule,
    cssSupport.rejection("align-items", "baseline")!.fix,
    (d, v) => ((d.name === "align-items" || d.name === "align-self" || d.name === "align-content") && /\bbaseline\b/i.test(v) ? declText(d, v) : null), { pseudo: true }),
};
