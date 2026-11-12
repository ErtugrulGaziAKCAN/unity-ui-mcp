import { clip } from "../css-values.js";
import type { Rule } from "../types.js";
import { at, Collector, isExternal, nonDesign, resolved, sources, targetOf } from "./util.js";

const FIX = "Use a real element instead of generated content (::before/::after content, list markers): an icon, bullet or divider element; set list-style: none on list items.";

export const rule: Rule = {
  id: "U-CSS-002", severity: "error",
  check(s) {
    const c = new Collector();
    const covered = new Set<number>();
    for (const src of sources(s)) {
      const content = src.decls.find((d) => d.name === "content");
      if (!content) continue;
      for (const p of ["before", "after"]) {
        if (!src.pseudo.has(p)) continue;
        const t = targetOf(s, src, p);
        if (!t) continue;
        const v = resolved(s, content.value, t.element?.index ?? null).trim();
        if (v === "none" || v === "normal") continue;
        (src.pseudo.get(p) ?? []).forEach((i) => covered.add(i));
        c.add(t.path, `::${p} { content: ${clip(v)} }${at(src, t)}`);
      }
    }
    // generated content the rules above do not explain (e.g. user-agent quotes)
    for (const e of s.elements) {
      if (covered.has(e.index) || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      for (const p of ["before", "after"] as const) if (e.pseudo[p]) c.add(e.path, `::${p} renders content ${clip(e.pseudo[p]!.content)}`);
      const k = e.computed;
      if (e.rendered && k.display.includes("list-item") && (k["list-style-type"] !== "none" || k["list-style-image"] !== "none")) {
        c.add(e.path, `list item renders a ::marker (${k["list-style-image"] !== "none" ? k["list-style-image"] : k["list-style-type"]})`);
      }
    }
    return c.findings(rule, FIX);
  },
};
