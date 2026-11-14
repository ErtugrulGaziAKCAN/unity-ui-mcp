import type { Rule } from "../types.js";
import { isTextElement } from "../text-runs.js";
import { Collector, isExternal, nonDesign } from "./util.js";

const FIX = "Give the text at least as much right padding as its negative letter-spacing (padding-right: 2px for letter-spacing: " +
  "-1.28px), or use a letter-spacing of 0 or more. UI Toolkit draws no spacing after a line's last character, which Chromium " +
  "does; the compiler takes it from the right padding, and UI Toolkit lays out no negative padding.";

const px = (v: string | undefined) => (v && v.endsWith("px") ? parseFloat(v) : v === "normal" ? 0 : NaN);

/**
 * Negative letter-spacing on a text with less right padding than the spacing. The compiler gives a text the spacing after
 * its last character as right padding (UI Toolkit's standard generator draws none there, Chromium does); with negative
 * spacing that padding would be negative, and UI Toolkit lays negative padding out as 0 (measured on 6000.3: neither a
 * negative padding nor a negative margin keeps the box and the line where Chromium puts them).
 */
export const rule: Rule = {
  id: "U-CSS-044", severity: "error",
  check(s) {
    const c = new Collector();
    for (const e of s.elements) {
      if (e.ns !== "html" || isExternal(s, e.index) || nonDesign(s)[e.index] || !isTextElement(s, e)) continue;
      const spacing = px(e.computed["letter-spacing"]), padding = px(e.computed["padding-right"]);
      if (!(spacing < 0) || !(padding + spacing < -1e-6)) continue;
      c.add(e.path, `letter-spacing ${e.computed["letter-spacing"]} with padding-right ${e.computed["padding-right"]}: the text needs at least ${-spacing}px of right padding`);
    }
    return c.findings(rule, FIX);
  },
};
