import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "W-FONT-002", severity: "warning",
  check: (_s, _k, _b, ctx) => ctx.fonts.unreadable.map((f) => make(rule, `@font-face "${f.family}"`,
    `kit font face "${f.family}" (src: ${f.src ?? "?"}) could not be read: its glyph coverage (U-FONT-003) and identity are not verified`,
    "Ship kit fonts as TrueType, OpenType or WOFF files referenced with url() (kit sync copies the TMP fonts' source files).")),
};
