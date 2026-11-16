import { referenceIsEnglish } from "../../kit.js";
import { clip } from "../css-values.js";
import type { Finding, Rule } from "../types.js";
import { TEXT_ATTRS } from "./U-MRK-007.js";
import { isExternal, make, nonDesign } from "./util.js";

const FIX = "With the reference locale en the visible text is the English String Table entry (what the design shows and verify " +
  "checks): write data-en exactly as the visible text (a variable as {name}, a <br> as a line break), or leave data-en out.";

/**
 * With the reference locale English one String Table holds the reference and the English text, and its entry is the
 * visible text: a `data-en` (or `data-en-<attr>`) that says something else would ship text the design never showed. It
 * may be left out; when written it is the visible text as it renders (collapsed whitespace, variables as `{name}`, a
 * `<br>` as a line break), character for character: the entry is written as data-en says. The import refuses the same
 * difference.
 */
export const rule: Rule = {
  id: "U-MRK-014", severity: "error",
  check(s, kit) {
    if (!referenceIsEnglish(kit)) return [];
    const out: Finding[] = [];
    for (const e of s.elements) {
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const bad: string[] = [];
      const en = e.attrs["data-en"];
      if (e.attrs["data-l10n"] !== undefined && en !== undefined && en.trim() !== "" && e.enText !== undefined && en !== e.enText) {
        bad.push(`data-en "${clip(en, 60)}" is not the visible text "${clip(e.enText, 60)}"`);
      }
      for (const a of TEXT_ATTRS) {
        const v = e.attrs[a], ea = e.attrs[`data-en-${a}`];
        if (v === undefined || v.trim() === "" || e.attrs[`data-l10n-${a}`] === undefined || ea === undefined || ea.trim() === "") continue;
        if (ea !== v) bad.push(`data-en-${a} "${clip(ea, 60)}" is not the ${a} "${clip(v, 60)}"`);
      }
      if (bad.length) out.push(make(rule, e.path, bad.join("; "), FIX));
    }
    return out;
  },
};
