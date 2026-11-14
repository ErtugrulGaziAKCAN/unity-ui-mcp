import { splitTopLevel } from "../css-values.js";
import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

const TIMING = /^(transition|animation)-timing-function$/;
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/i;
/** An easing function call in a transition/animation shorthand (keywords are checked by the property's own rule). */
const CALL = /\b(cubic-bezier|steps|linear)\s*\(([^()]*)\)/gi;

/**
 * Transition and animation easing: what the animation player evaluates exactly — the keywords (linear, ease, ease-in,
 * ease-out, ease-in-out, step-start, step-end), cubic-bezier() with x values in [0, 1] and steps(); never linear() with
 * points or a malformed function.
 */
export const rule: Rule = {
  id: "U-CSS-008", severity: "error",
  check: (s) => declRule(s, rule, cssSupport.fixFor("transition-timing-function"),
    (d, v) => {
      if (TIMING.test(d.name)) {
        return splitTopLevel(v, ",").some((i) => !cssSupport.isTimingFunction(i) && !CSS_WIDE.test(i.trim())) ? declText(d, v) : null;
      }
      if (d.name === "transition" || d.name === "animation") {
        for (const m of v.matchAll(CALL)) if (!cssSupport.isTimingFunction(m[0].replace(/\s*\(/, "("))) return declText(d, v);
      }
      return null;
    }, { pseudo: true, keyframes: true }),
};
