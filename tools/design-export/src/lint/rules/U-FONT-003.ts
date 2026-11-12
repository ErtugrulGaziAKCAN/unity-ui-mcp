import { firstFamily } from "../css-values.js";
import type { Rule } from "../types.js";
import { make, textElements } from "./util.js";

/** Glyph fallback: every glyph of visible text must come from a kit font file, never from a platform font. */
export const rule: Rule = {
  id: "U-FONT-003", severity: "error",
  check(s, _k, _b, ctx) {
    const out = [];
    const ps = ctx.fonts.postScriptNames;
    for (const e of textElements(s)) {
      // a non-kit family is U-CSS-010's finding
      if (!ctx.fonts.families.has(firstFamily(e.computed["font-family"]).toLowerCase())) continue;
      const bad = new Map<string, number>();
      e.textFonts.forEach((fonts) => {
        for (const f of fonts ?? []) {
          if (f.glyphCount <= 0) continue;
          const kitFile = f.isCustomFont && (ps === null || ps.has(f.postScriptName));
          if (!kitFile) bad.set(`${f.familyName} (${f.postScriptName})`, (bad.get(`${f.familyName} (${f.postScriptName})`) ?? 0) + f.glyphCount);
        }
      });
      if (!bad.size) continue;
      out.push(make(rule, e.path, `glyphs rendered by fonts outside the kit: ${Array.from(bad, ([n, c]) => `${n} ${c} glyph${c > 1 ? "s" : ""}`).join(", ")}`,
        "Use only characters the kit font covers, or add a font that covers them as a TMP fallback in the Unity project and re-run kit sync."));
    }
    return out;
  },
};
