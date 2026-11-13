import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

/** title tooltips: UI Toolkit draws tooltips only in Editor panels, so players never see them. */
export const rule: Rule = {
  id: "I-MRK-001", severity: "info",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (e.ns !== "html" || (e.attrs.title ?? "").trim() === "" || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      out.push(make(rule, e.path, `title="${e.attrs.title}" becomes a tooltip, which UI Toolkit shows only in Editor panels, not in game`,
        "Keep the localized title if the hint is for the Editor only; show a hint players need with a visible element (for example on hover)."));
    }
    return out;
  },
};
