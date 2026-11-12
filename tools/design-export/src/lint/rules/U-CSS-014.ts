import { stripStringsAndUrls } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-014", severity: "error",
  check: (s) => declRule(s, rule, "Remove inset: use an outer box-shadow, a border, or an inner element for the inner shade.",
    (d, v) => (d.name === "box-shadow" && /(^|[\s,])inset([\s,]|$)/i.test(stripStringsAndUrls(v)) ? declText(d, v) : null), { pseudo: true }),
};
