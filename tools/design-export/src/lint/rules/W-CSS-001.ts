import { cssSupport } from "../allowed-css.js";
import { splitTopLevel } from "../css-values.js";
import type { Rule } from "../types.js";
import { at, Collector, resolved, sources, targetOf } from "./util.js";

const seconds = (t: string) => { const m = /^([\d.]+)(m?s)$/.exec(t.trim()); return m ? Number(m[1]) / (m[2] === "ms" ? 1000 : 1) : NaN; };

export const rule: Rule = {
  id: "W-CSS-001", severity: "warning",
  check(s) {
    const c = new Collector();
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      const v = (n: string) => { const d = src.decls.find((x) => x.name === n); return d ? resolved(s, d.value, t.element?.index ?? null) : null; };
      const props = v("transition-property");
      if (props === null) continue;
      const durs = v("transition-duration");
      const list = splitTopLevel(props, ",");
      const dl = durs === null ? [] : splitTopLevel(durs, ",");
      const bad = list.filter((p, i) => cssSupport.isLayoutTransitionProperty(p.trim()) && (dl.length === 0 || !(seconds(dl[i % dl.length]) === 0)));
      if (bad.length) c.add(t.path, `transition on ${bad.join(", ")}${bad.includes("all") ? " (all includes layout properties)" : ""}${at(src, t)}`);
    }
    return c.findings(rule, "Transition only transform, translate, rotate, scale and colours (opacity on an element that paints one thing, U-CSS-039); a layout property transition re-runs layout every frame.");
  },
};
