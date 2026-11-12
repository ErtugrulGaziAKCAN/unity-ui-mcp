import { cssSupport } from "../allowed-css.js";
import { functionNames } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

/** Properties whose functions a dedicated rule judges (content U-CSS-002, filters U-CSS-007/015, timing U-CSS-008, transforms U-CSS-025). */
const OWNED = /^(content|filter|-webkit-filter|backdrop-filter|-webkit-backdrop-filter|transition(-.*)?|transform|translate|rotate|scale)$/;

export const rule: Rule = {
  id: "U-CSS-024", severity: "error",
  check: (s) => declRule(s, rule,
    "Replace the function with a literal value; allowed: var(), rgb()/rgba(), hsl()/hsla(), linear-gradient(), radial-gradient(), url() (and translate/rotate/scale in transform).",
    (d, v) => {
      if (OWNED.test(d.name)) return null;
      const bad = functionNames(v).filter((n) => n !== "calc" && n !== "-webkit-calc" && !cssSupport.isAllowedFunction(n));
      return bad.length ? `${declText(d, v)} (${Array.from(new Set(bad)).map((n) => `${n}()`).join(", ")})` : null;
    }, { pseudo: true, keyframes: true }),
};
