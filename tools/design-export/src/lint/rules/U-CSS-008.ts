import { functionNames, splitTopLevel } from "../css-values.js";
import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-008", severity: "error",
  check: (s) => declRule(s, rule, `Use one of ${cssSupport.timingKeywords.join(", ")} as the transition timing function.`,
    (d, v) => {
      if (d.name === "transition-timing-function") {
        return splitTopLevel(v, ",").some((i) => !cssSupport.isTimingKeyword(i) && !/^(inherit|initial|unset|revert)$/i.test(i)) ? declText(d, v) : null;
      }
      if (d.name === "transition") return functionNames(v).some((n) => /^(cubic-bezier|steps|linear)$/.test(n)) || /\bstep-(start|end)\b/i.test(v) ? declText(d, v) : null;
      return null;
    }, { pseudo: true }),
};
