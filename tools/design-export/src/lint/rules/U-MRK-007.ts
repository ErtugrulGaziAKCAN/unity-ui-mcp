import { referenceIsEnglish } from "../../kit.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

export const TEXT_ATTRS = ["placeholder", "title", "alt", "aria-label"];

/**
 * Text in attributes is player-facing too: each needs its own key and English source (with the reference locale English the
 * attribute's own text is the English entry, so data-en-<attr> may be left out; U-MRK-014 compares it when written).
 */
export const rule: Rule = {
  id: "U-MRK-007", severity: "error",
  check(s, kit) {
    const out = [];
    const english = referenceIsEnglish(kit);
    for (const e of s.elements) {
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const bad = TEXT_ATTRS.filter((a) => (e.attrs[a] ?? "").trim() !== "" && (!e.attrs[`data-l10n-${a}`] || (!english && (e.attrs[`data-en-${a}`] ?? "").trim() === "")));
      if (!bad.length) continue;
      out.push(make(rule, e.path, bad.map((a) => `${a}="${e.attrs[a]}" has no data-l10n-${a} / data-en-${a}`).join(", "),
        `Add data-l10n-<attribute>="<key>" and data-en-<attribute>="<English text>" for every text attribute (${TEXT_ATTRS.join(", ")}), e.g. data-l10n-placeholder="inbox.search" data-en-placeholder="Search".`));
    }
    return out;
  },
};
