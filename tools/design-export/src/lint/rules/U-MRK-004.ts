import { clip } from "../css-values.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

/** Visible static text is localizable: the nearest data-l10n/data-u-bind ancestor-or-self decides. */
export const rule: Rule = {
  id: "U-MRK-004", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (e.texts.length === 0 || nonDesign(s)[e.index] || isExternal(s, e.index)) continue;
      let k = e.index, problem: string | null = "no data-l10n / data-en and not inside data-u-bind";
      for (; k >= 0; k = s.elements[k].parent) {
        const a = s.elements[k].attrs;
        if (a["data-u-bind"] !== undefined) { problem = null; break; }
        if (a["data-l10n"] !== undefined) {
          problem = (a["data-en"] ?? "").trim() === "" ? `data-l10n="${a["data-l10n"]}" on ${s.elements[k].path} has no data-en` : null;
          break;
        }
      }
      if (problem === null) continue;
      if (s.elements[e.index].attrs["data-en"] !== undefined && k < 0) problem = "data-en without data-l10n";
      out.push(make(rule, e.path, `text "${clip(e.texts.join(" ").replace(/\s+/g, " ").trim(), 60)}": ${problem}`,
        'Add data-l10n="<screen.key>" and data-en="<English text>" to the element that holds the text, or mark runtime values with data-u-bind="<name>".'));
    }
    return out;
  },
};
