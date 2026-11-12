import { coversWeight } from "../fonts.js";
import type { Rule } from "../types.js";
import { make, textElements } from "./util.js";

/** Other locales are checked structurally: every weight the design uses needs a real face in each of their fonts. */
export const rule: Rule = {
  id: "W-FONT-001", severity: "warning",
  check(s, _k, _b, ctx) {
    const firstUse = new Map<number, { path: string; count: number }>();
    for (const e of textElements(s)) {
      const w = Number(e.computed["font-weight"]);
      const u = firstUse.get(w);
      if (u) u.count++; else firstUse.set(w, { path: e.path, count: 1 });
    }
    const out = [];
    for (const { locale, families } of ctx.fonts.otherLocales) for (const fam of families) for (const [w, u] of firstUse) {
      if (coversWeight(ctx.fonts.faces.get(fam), w)) continue;
      out.push(make(rule, u.path, `locale ${locale}: "${ctx.fonts.families.get(fam) ?? fam}" has no real ${w} face (${u.count} text element${u.count > 1 ? "s" : ""} use weight ${w})`,
        `Add the real ${w} face of that font to the locale's TMP weight table and re-run kit sync, or avoid weight ${w}.`));
    }
    return out;
  },
};
