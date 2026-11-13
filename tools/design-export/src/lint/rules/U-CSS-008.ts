import { functionNames, splitTopLevel } from "../css-values.js";
import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

const TIMING = /^(transition|animation)-timing-function$/;

/** Transition and animation easing: the five USS timing keywords only (no cubic-bezier, steps, step-start/end, linear()). */
export const rule: Rule = {
  id: "U-CSS-008", severity: "error",
  check: (s) => declRule(s, rule, `Use one of ${cssSupport.timingKeywords.join(", ")} as the timing function of transitions and animations.`,
    (d, v) => {
      if (TIMING.test(d.name)) {
        return splitTopLevel(v, ",").some((i) => !cssSupport.isTimingKeyword(i) && !/^(inherit|initial|unset|revert)$/i.test(i)) ? declText(d, v) : null;
      }
      if (d.name === "transition" || d.name === "animation") {
        return functionNames(v).some((n) => /^(cubic-bezier|steps|linear)$/.test(n)) || /\bstep-(start|end)\b/i.test(v) ? declText(d, v) : null;
      }
      return null;
    }, { pseudo: true, keyframes: true }),
};
