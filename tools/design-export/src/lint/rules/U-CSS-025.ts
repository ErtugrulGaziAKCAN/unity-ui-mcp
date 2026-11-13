import { px } from "../css-values.js";
import { individualTransformProblem, splitTransform } from "../resolve/transform.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-025", severity: "error",
  check: (s) => declRule(s, rule,
    "Use only translate()/translateX()/translateY(), rotate() and scale()/scaleX()/scaleY() in the order translate → rotate → scale (or the translate, rotate and scale properties); no matrix, skew, perspective or 3D functions.",
    (d, v, _src, t) => {
      if (d.name === "transform") {
        const e = t.element;
        const r = splitTransform(v, e?.size ?? undefined, { fontSize: px(e?.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize });
        return r.ok ? null : `${declText(d, v)}: ${r.reason}`;
      }
      if (d.name === "translate" || d.name === "rotate" || d.name === "scale") {
        const why = individualTransformProblem(d.name, v);
        return why ? `${declText(d, v)}: ${why}` : null;
      }
      return null;
    }, { pseudo: true, keyframes: true }),
};
