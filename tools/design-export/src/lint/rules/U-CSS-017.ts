import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-017", severity: "error",
  check: (s) => declRule(s, rule, "Use position: absolute inside the screen root instead of fixed or sticky, and flex layout instead of float.",
    (d, v) => {
      const x = v.trim().toLowerCase();
      if (d.name === "position" && /^(fixed|sticky|-webkit-sticky)$/.test(x)) return declText(d, v);
      if (d.name === "float" && x !== "none" && !/^(inherit|initial|unset|revert)$/.test(x)) return declText(d, v);
      return null;
    }, { pseudo: true }),
};
