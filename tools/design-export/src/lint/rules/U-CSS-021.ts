import type { Rule } from "../types.js";
import { at, Collector, isExternal, nonDesign, resolved, sources, targetOf } from "./util.js";

const STYLES = /\b(dotted|dashed|double|groove|ridge|inset|outset|hidden)\b/i;
const SIDES = ["top", "right", "bottom", "left"];

export const rule: Rule = {
  id: "U-CSS-021", severity: "error",
  check(s) {
    const c = new Collector();
    const covered = new Set<number>();
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      const hits: string[] = [];
      for (const d of src.decls) {
        const isStyle = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-style$/.test(d.name);
        const isShorthand = d.invalid && /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(d.name);
        if (!isStyle && !isShorthand) continue;
        src.elements.forEach((i) => covered.add(i));
        const v = resolved(s, d.value, t.element?.index ?? null);
        if (STYLES.test(v)) hits.push(`${d.name}: ${v}`);
      }
      if (hits.length) c.add(t.path, Array.from(new Set(hits)).join(", ") + at(src, t));
    }
    // borders the design did not style (user-agent defaults such as an input's inset border)
    for (const e of s.elements) {
      if (covered.has(e.index) || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const bad = SIDES.filter((k) => e.computed[`border-${k}-width`] !== "0px" && !/^(solid|none)$/.test(e.computed[`border-${k}-style`]));
      if (bad.length) c.add(e.path, `default border ${bad.map((k) => `${k} ${e.computed[`border-${k}-style`]}`).join(", ")}`);
    }
    return c.findings(rule, "Use border-style solid (or none); draw dashed or dotted lines as an SVG image.");
  },
};
