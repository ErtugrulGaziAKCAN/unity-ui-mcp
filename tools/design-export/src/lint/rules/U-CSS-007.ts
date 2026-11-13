import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-007", severity: "error",
  check: (s) => declRule(s, rule, cssSupport.fixFor("backdrop-filter"),
    (d, v) => ((d.name === "backdrop-filter" || d.name === "-webkit-backdrop-filter") && v.trim() !== "none" ? declText(d, v) : null), { pseudo: true }),
};
