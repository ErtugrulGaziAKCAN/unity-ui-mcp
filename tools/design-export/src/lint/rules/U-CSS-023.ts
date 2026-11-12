import { cssSupport } from "../allowed-css.js";
import { CSS_WIDE, stripStringsAndUrls } from "../css-values.js";
import type { Rule } from "../types.js";
import { at, Collector, declText, resolved, sources, targetOf } from "./util.js";

const UNIT = /(^|[^\w.#-])[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([a-z]+)(?![\w(-])/gi;
const VIEWPORT = /^[sld]?v(?:w|h|i|b|min|max)$/; // U-CSS-006
/** Values the exporter resolves to px itself (text styles, corner radii) or another rule owns. */
const UNIT_EXEMPT = new Set(["U-CSS-002", "U-CSS-016", "U-CSS-020"]);

/** Catch-all: every specified property must be one the pipeline supports (allowed-css.ts), in supported units. */
export const rule: Rule = {
  id: "U-CSS-023", severity: "error",
  check(s) {
    const c = new Collector();
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      const hits: string[] = [];
      for (const sel of src.rule?.selectors ?? []) {
        if (sel.pseudoElement && !cssSupport.isAllowedPseudoElement(sel.pseudoElement)) hits.push(`::${sel.pseudoElement} (in "${sel.text}") has no UI Toolkit equivalent`);
      }
      for (const d of src.decls) {
        if (d.name.startsWith("--")) continue;
        const v = resolved(s, d.value, t.element?.index ?? null);
        if (d.invalid) { hits.push(`${d.name}: ${v} does not parse after var() substitution`); continue; }
        // initial values (what shorthands write) and CSS-wide keywords add nothing an ancestor's declaration does not
        if (cssSupport.isInitialValue(d.name, v) || CSS_WIDE.has(v.trim().toLowerCase())) continue;
        const p = cssSupport.property(d.name);
        if (!p || (p.handling === "error" && !p.rule)) { hits.push(`${declText(d, v)} is not supported`); continue; }
        if (p.rule && UNIT_EXEMPT.has(p.rule)) continue;
        const units = Array.from(stripStringsAndUrls(v).matchAll(UNIT), (m) => m[2].toLowerCase())
          .filter((u) => !cssSupport.isAllowedUnit(u) && !VIEWPORT.test(u) && u !== "e");
        if (units.length) hits.push(`${declText(d, v)} uses unit ${Array.from(new Set(units)).join(", ")}`);
      }
      if (hits.length) c.add(t.path, hits.join(", ") + at(src, t));
    }
    return c.findings(rule, "Remove the property or express it with supported CSS (spec §5.3; the list is src/lint/allowed-css.ts); use px, % or rem lengths.");
  },
};
