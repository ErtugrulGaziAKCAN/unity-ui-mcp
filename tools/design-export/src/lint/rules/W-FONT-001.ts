import { coversStyle, coversWeight } from "../fonts.js";
import type { Rule } from "../types.js";
import { make, textElements } from "./util.js";

/** Other locales are checked structurally: every weight and italic the design uses needs a real face in their fonts. */
export const rule: Rule = {
  id: "W-FONT-001", severity: "warning",
  check(s, _k, _b, ctx) {
    const firstUse = new Map<string, { path: string; count: number; weight?: number; italic?: boolean }>();
    const use = (key: string, path: string, extra: { weight?: number; italic?: boolean }) => {
      const u = firstUse.get(key);
      if (u) u.count++; else firstUse.set(key, { path, count: 1, ...extra });
    };
    for (const e of textElements(s)) {
      use(`w${e.computed["font-weight"]}`, e.path, { weight: Number(e.computed["font-weight"]) });
      if (/^(italic|oblique)/.test(e.computed["font-style"])) use("italic", e.path, { italic: true });
    }
    const out = [];
    for (const { locale, families } of ctx.fonts.otherLocales) for (const fam of families) for (const u of firstUse.values()) {
      const faces = ctx.fonts.faces.get(fam);
      const what = u.italic ? "italic" : `${u.weight}`;
      if (u.italic ? coversStyle(faces, true) : coversWeight(faces, u.weight!)) continue;
      out.push(make(rule, u.path, `locale ${locale}: "${ctx.fonts.families.get(fam) ?? fam}" has no real ${what} face (${u.count} text element${u.count > 1 ? "s" : ""} use it)`,
        `Add the real ${what} face of that font to the locale's TMP weight table and re-run kit sync, or avoid ${u.italic ? "italic" : `weight ${what}`}.`));
    }
    return out;
  },
};
