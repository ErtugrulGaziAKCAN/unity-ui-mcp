import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-028", severity: "error",
  check(s) {
    return s.atRules.flatMap((a) => {
      const allowed = cssSupport.atRule(a.kind);
      if (allowed === "any" || (allowed === "kit" && a.kit)) return [];
      if (a.kind === "font-face") return []; // a design's own @font-face is U-FONT-002
      const why = allowed === "kit" ? `@${a.kind} is only for the kit's own stylesheets` : `@${a.kind} has no UI Toolkit equivalent`;
      return [make(rule, a.path, why,
        a.kind === "import" ? "Put the styles in the design's own <style> or <link> instead of @import."
          : "Use only @media (min/max-width, min/max-aspect-ratio) and @keyframes; write the styles without @layer, @supports, @container, @starting-style, @property or @page.")];
    });
  },
};
