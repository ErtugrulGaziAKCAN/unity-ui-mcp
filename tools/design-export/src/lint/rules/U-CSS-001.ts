import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-001", severity: "error",
  check: (s) => declRule(s, rule, "Use display: flex (nested flex rows and columns; flex-wrap for tiles) instead of grid.",
    (d, v) => (d.name === "display" && /(^|\s)(inline-)?grid(\s|$)/i.test(v.trim()) ? declText(d, v) : null), { pseudo: true }),
};
