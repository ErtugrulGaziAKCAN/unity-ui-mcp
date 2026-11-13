import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { at, Collector, resolved, sources, targetOf } from "./util.js";

const STYLES = /\b(dotted|dashed|double|groove|ridge|inset|outset|hidden)\b/i;

export const rule: Rule = {
  id: "U-CSS-021", severity: "error",
  check(s) {
    const c = new Collector();
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      const hits: string[] = [];
      for (const d of src.decls) {
        const isStyle = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-style$/.test(d.name);
        const isShorthand = d.invalid && /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(d.name);
        if (!isStyle && !isShorthand) continue;
        const v = resolved(s, d.value, t.element?.index ?? null);
        if (STYLES.test(v)) hits.push(`${d.name}: ${v}`);
      }
      if (hits.length) c.add(t.path, Array.from(new Set(hits)).join(", ") + at(src, t));
    }
    return c.findings(rule, cssSupport.rejection("border-top-style", "dashed")!.fix);
  },
};
