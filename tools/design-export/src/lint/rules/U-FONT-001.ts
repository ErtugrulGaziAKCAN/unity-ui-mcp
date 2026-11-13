import { firstFamily } from "../css-values.js";
import { coversStyle, coversWeight } from "../fonts.js";
import type { Rule } from "../types.js";
import { inFlow, make, textElements } from "./util.js";

const italic = (style: string) => /^(italic|oblique)/.test(style);

/**
 * A weight or italic style without a real face in the reference locale's font is synthesized, and Chromium and UI
 * Toolkit synthesize differently (M0 R3: bold widens advances by 14 %; italic not measured).
 */
export const rule: Rule = {
  id: "U-FONT-001", severity: "error",
  check(s, _k, _b, ctx) {
    const out = [];
    for (const e of textElements(s)) {
      const fam = firstFamily(e.computed["font-family"]).toLowerCase();
      if (!ctx.fonts.referenceFamilies.has(fam)) continue;
      const w = Number(e.computed["font-weight"]), it = italic(e.computed["font-style"]);
      if (inFlow(e) && e.parent >= 0) {
        const p = s.elements[e.parent].computed;
        if (p["font-weight"] === e.computed["font-weight"] && p["font-style"] === e.computed["font-style"] && p["font-family"] === e.computed["font-family"]) continue;
      }
      const faces = ctx.fonts.faces.get(fam);
      const missing = [...(coversWeight(faces, w) ? [] : [`weight ${w}`]), ...(it && !coversStyle(faces, true) ? ["italic"] : [])];
      if (!missing.length) continue;
      out.push(make(rule, e.path, `${missing.join(" and ")} has no real face in "${ctx.fonts.families.get(fam)}" (reference locale ${ctx.fonts.referenceLocale}); it would be synthesized`,
        "Use weight 400 or 700 and upright text, or add the real face to the TMP font's weight table and re-run kit sync."));
    }
    return out;
  },
};
