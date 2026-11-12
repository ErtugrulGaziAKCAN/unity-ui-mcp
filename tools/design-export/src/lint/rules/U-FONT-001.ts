import { firstFamily } from "../css-values.js";
import { coversWeight } from "../fonts.js";
import type { Rule } from "../types.js";
import { inFlow, make, textElements } from "./util.js";

/** A weight without a real face in the reference locale's font is synthesized differently by Chromium and UI Toolkit (M0 R3). */
export const rule: Rule = {
  id: "U-FONT-001", severity: "error",
  check(s, _k, _b, ctx) {
    const out = [];
    for (const e of textElements(s)) {
      const fam = firstFamily(e.computed["font-family"]).toLowerCase();
      if (!ctx.fonts.referenceFamilies.has(fam)) continue;
      const w = Number(e.computed["font-weight"]);
      if (inFlow(e) && e.parent >= 0) {
        const p = s.elements[e.parent];
        if (p.computed["font-weight"] === e.computed["font-weight"] && p.computed["font-family"] === e.computed["font-family"]) continue;
      }
      if (coversWeight(ctx.fonts.faces.get(fam), w)) continue;
      out.push(make(rule, e.path, `weight ${w} has no real face in "${ctx.fonts.families.get(fam)}" (reference locale ${ctx.fonts.referenceLocale}); it would be synthesized`,
        "Use weight 400 or 700, or add the real face to the TMP weight table and re-run kit sync."));
    }
    return out;
  },
};
