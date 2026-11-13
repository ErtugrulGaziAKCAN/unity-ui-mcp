import type { Rule } from "../types.js";
import { Collector, isExternal, nonDesign, resolved, sourcesOf } from "./util.js";

const GAPS = new Set(["gap", "row-gap", "column-gap", "grid-gap", "grid-row-gap", "grid-column-gap"]);
const zero = (v: string) => /^(normal|0|0px|0%)(\s+(normal|0|0px|0%))?$/i.test(v.trim());
const wraps = (v: string) => /\bwrap(-reverse)?\b/i.test(v);

/** gap and wrapping on one flex container, from any combination of layers (base, hover, breakpoints, states). */
export const rule: Rule = {
  id: "U-CSS-011", severity: "error",
  check(s) {
    const c = new Collector();
    sourcesOf(s).forEach((list, i) => {
      const e = s.elements[i];
      if (isExternal(s, i) || nonDesign(s)[i]) return;
      const k = e.computed;
      const gaps: string[] = [], wrapsIn: string[] = [];
      if (k.display.endsWith("flex") && (!zero(k["row-gap"]) || !zero(k["column-gap"]))) gaps.push(`row-gap ${k["row-gap"]}, column-gap ${k["column-gap"]}`);
      if (wraps(k["flex-wrap"])) wrapsIn.push(`flex-wrap: ${k["flex-wrap"]}`);
      for (const src of list) for (const d of src.decls) {
        const v = resolved(s, d.value, i);
        if (GAPS.has(d.name) && !zero(v)) gaps.push(`${d.name}: ${v} [${src.where}]`);
        if ((d.name === "flex-wrap" || d.name === "flex-flow") && wraps(v)) wrapsIn.push(`${d.name}: ${v} [${src.where}]`);
      }
      if (gaps.length && wrapsIn.length) c.add(e.path, `${Array.from(new Set(gaps))[0]} with ${Array.from(new Set(wrapsIn))[0]}`);
    });
    return c.findings(rule, "Remove gap from wrapping flex containers and space the items with margins (gap is lowered to margins, which cannot follow line breaks).");
  },
};
