import type { Rule } from "../types.js";
import { at, Collector, isExternal, nonDesign, resolved, sources, targetOf } from "./util.js";

const GAPS = new Set(["gap", "row-gap", "column-gap", "grid-gap", "grid-row-gap", "grid-column-gap"]);
const zero = (v: string) => /^(normal|0|0px|0%)(\s+(normal|0|0px|0%))?$/i.test(v.trim());
const wraps = (v: string) => /\bwrap(-reverse)?\b/i.test(v);

export const rule: Rule = {
  id: "U-CSS-011", severity: "error",
  check(s) {
    const c = new Collector();
    for (const e of s.elements) {
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const k = e.computed;
      if (!k.display.endsWith("flex") || !wraps(k["flex-wrap"])) continue;
      if (!zero(k["row-gap"]) || !zero(k["column-gap"])) c.add(e.path, `flex-wrap: ${k["flex-wrap"]} with row-gap ${k["row-gap"]}, column-gap ${k["column-gap"]}`);
    }
    // gaps declared in rules the current state does not apply (hover, breakpoints, states)
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      const gap = src.decls.find((d) => GAPS.has(d.name) && !zero(resolved(s, d.value, t.element?.index ?? null)));
      if (!gap) continue;
      const wrapDecl = src.decls.find((d) => (d.name === "flex-wrap" || d.name === "flex-flow") && wraps(resolved(s, d.value, t.element?.index ?? null)));
      const wrapped = src.elements.find((i) => wraps(s.elements[i].computed["flex-wrap"]));
      if (!wrapDecl && wrapped === undefined) continue;
      const path = wrapped !== undefined ? s.elements[wrapped].path : t.path;
      if (!c.has(path)) c.add(path, `${gap.name}: ${gap.value} on a wrapping flex container${at(src, t)}`);
    }
    return c.findings(rule, "Remove gap from wrapping flex containers and space the items with margins (gap is lowered to margins, which cannot follow line breaks).");
  },
};
