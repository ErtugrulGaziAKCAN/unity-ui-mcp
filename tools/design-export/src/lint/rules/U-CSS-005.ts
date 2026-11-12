import { functionNames } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-005", severity: "error",
  check: (s) => declRule(s, rule, "Replace calc() with the resulting px or % value.",
    (d, v) => (functionNames(v).some((n) => n === "calc" || n === "-webkit-calc") ? declText(d, v) : null), { pseudo: true, keyframes: true }),
};
