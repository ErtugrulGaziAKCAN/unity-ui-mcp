import { referenceIsEnglish } from "../../kit.js";
import { clip } from "../css-values.js";
import type { Rule } from "../types.js";
import { inFlow, isExternal, make, nonDesign } from "./util.js";

const RICH = new Set(["b", "strong", "i", "em", "span"]);

/**
 * Visible static text is localizable on the element that holds it: data-l10n (+ data-en) or data-u-bind on the text's
 * element, or on the paragraph it sits in when only rich inline tags (b, strong, i, em, span) are in between. A key on
 * an ancestor that holds several text elements would give them one key. With the reference locale English the visible
 * text is the English entry, so data-en may be left out (U-MRK-014 compares it when written).
 */
export const rule: Rule = {
  id: "U-MRK-004", severity: "error",
  check(s, kit) {
    const out = [];
    const english = referenceIsEnglish(kit);
    for (const e of s.elements) {
      if (e.texts.length === 0 || nonDesign(s)[e.index] || isExternal(s, e.index)) continue;
      let k = e.index, problem: string | null = null;
      for (;;) {
        const x = s.elements[k], a = x.attrs;
        if (a["data-u-bind"] !== undefined || a["data-u-arg"] !== undefined) break; // runtime values
        if (a["data-l10n"] !== undefined) {
          if (!english && (a["data-en"] ?? "").trim() === "") problem = `data-l10n="${a["data-l10n"]}" on ${x.path} has no data-en`;
          break;
        }
        if (!(inFlow(x) && RICH.has(x.tag)) || x.parent < 0) {
          let up = x.parent;
          while (up >= 0 && s.elements[up].attrs["data-l10n"] === undefined && s.elements[up].attrs["data-u-bind"] === undefined) up = s.elements[up].parent;
          problem = up >= 0 ? `the key on ${s.elements[up].path} covers more than one text element; this text needs its own data-l10n`
            : a["data-en"] !== undefined ? "data-en without data-l10n" : "no data-l10n / data-en and not data-u-bind";
          break;
        }
        k = x.parent;
      }
      if (problem === null) continue;
      out.push(make(rule, s.elements[k].path, `text "${clip(e.texts.join(" ").replace(/\s+/g, " ").trim(), 60)}": ${problem}`,
        'Put data-l10n="<screen.key>" and data-en="<English text>" on the element that holds the text (rich b/i/span inside it are covered), or data-u-bind="<name>" for a runtime value.'));
    }
    return out;
  },
};
