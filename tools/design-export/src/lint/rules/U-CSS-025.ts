import { px } from "../css-values.js";
import { individualTransformProblem, splitTransform } from "../resolve/transform.js";
import type { Rule } from "../types.js";
import { declRule, declText, inSvg, make, resolved, sourcesOf } from "./util.js";

const INDIVIDUAL = ["translate", "rotate", "scale"];

export const rule: Rule = {
  id: "U-CSS-025", severity: "error",
  check: (s) => [...combined(s), ...declRule(s, rule,
    "Use only translate()/translateX()/translateY(), rotate() and scale()/scaleX()/scaleY() in the order translate → rotate → scale (or the translate, rotate and scale properties); no matrix, skew, perspective or 3D functions.",
    (d, v, _src, t) => {
      if (d.name === "transform") {
        const e = t.element;
        const r = splitTransform(v, e?.size ?? undefined, { fontSize: px(e?.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize });
        // without a box (the rule reaches no element) a % translation cannot be resolved: not judged
        if (!r.ok && !e && /needs to come first/.test(r.reason)) return null;
        return r.ok ? null : `${declText(d, v)}: ${r.reason}`;
      }
      if (d.name === "translate" || d.name === "rotate" || d.name === "scale") {
        const why = individualTransformProblem(d.name, v);
        return why ? `${declText(d, v)}: ${why}` : null;
      }
      return null;
    }, { pseudo: true, keyframes: true })],
};

/** transform together with translate/rotate/scale on one element: CSS composes both, the IR has one split. */
function combined(s: Parameters<typeof sourcesOf>[0]) {
  const out = [];
  for (const e of s.elements) {
    if (inSvg(s)[e.index]) continue;
    const names = new Set<string>();
    for (const src of sourcesOf(s)[e.index]) for (const d of src.decls) {
      if ((d.name === "transform" || INDIVIDUAL.includes(d.name)) && resolved(s, d.value, e.index).trim() !== "none") names.add(d.name);
    }
    const ind = INDIVIDUAL.filter((n) => names.has(n));
    if (names.has("transform") && ind.length) {
      out.push(make(rule, e.path, `transform and ${ind.join(", ")} on one element`,
        "Use either transform (translate → rotate → scale) or the translate, rotate and scale properties on an element, not both."));
    }
  }
  return out;
}
