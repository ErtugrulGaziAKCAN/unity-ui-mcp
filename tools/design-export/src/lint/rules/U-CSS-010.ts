import { CSS_WIDE, firstFamily } from "../css-values.js";
import type { Rule } from "../types.js";
import { at, Collector, inFlow, isExternal, nonDesign, resolved, sources, targetOf, textElements } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-010", severity: "error",
  check(s, _kit, _b, ctx) {
    const kitNames = Array.from(ctx.fonts.families.values());
    const isKit = (stack: string) => ctx.fonts.families.has(firstFamily(stack).toLowerCase());
    const c = new Collector();
    for (const e of textElements(s)) {
      if (e.tag === "option") continue; // drawn by the native popup, not the screen
      const fam = e.computed["font-family"];
      // rich text inherits the paragraph's font: report it only where it differs
      if (inFlow(e) && e.parent >= 0 && s.elements[e.parent].computed["font-family"] === fam) continue;
      if (!isKit(fam)) c.add(e.path, `text renders with font-family ${fam}`);
    }
    for (const e of s.elements) {
      const ph = e.pseudo.placeholder;
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      if (ph && !isKit(ph["font-family"])) c.add(e.path, `::placeholder renders with font-family ${ph["font-family"]}`);
    }
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      for (const d of src.decls) {
        if (d.name !== "font-family") continue;
        const v = resolved(s, d.value, t.element?.index ?? null).trim();
        if (CSS_WIDE.has(v.toLowerCase()) || isKit(v)) continue;
        c.add(t.path, `font-family: ${v}${at(src, t)}`);
      }
    }
    return c.findings(rule, `Put a kit font family first in font-family (${kitNames.map((n) => `"${n}"`).join(", ") || "the kit declares none"}).`);
  },
};
