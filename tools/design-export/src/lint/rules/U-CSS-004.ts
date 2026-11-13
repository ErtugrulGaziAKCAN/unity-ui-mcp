import type { Rule } from "../types.js";
import { at, Collector, declText, resolved, sources, sourcesOf, targetOf } from "./util.js";

const FIX = "Use z-index only on position: absolute elements; order in-flow siblings in the markup instead (UI Toolkit draws in hierarchy order).";

/** z-index from any layer on an element that no layer makes absolute. */
export const rule: Rule = {
  id: "U-CSS-004", severity: "error",
  check(s) {
    const c = new Collector();
    const zOf = (src: ReturnType<typeof sources>[number], i: number | null) =>
      src.decls.find((d) => d.name === "z-index" && resolved(s, d.value, i).trim() !== "auto");
    const absoluteIn = (src: ReturnType<typeof sources>[number], i: number | null) =>
      src.decls.some((d) => d.name === "position" && resolved(s, d.value, i).trim() === "absolute");
    sourcesOf(s).forEach((list, i) => {
      const z = list.find((src) => zOf(src, i));
      if (!z) return;
      if (s.elements[i].computed.position === "absolute" || list.some((src) => absoluteIn(src, i))) return;
      const d = zOf(z, i)!;
      c.add(s.elements[i].path, `${declText(d, resolved(s, d.value, i))} on position: ${s.elements[i].computed.position}${at(z, { path: s.elements[i].path, element: s.elements[i], more: 0 })}`);
    });
    // rules that reach no element are judged on their own declarations
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t || t.element !== null) continue;
      const d = zOf(src, null);
      if (d && !absoluteIn(src, null)) c.add(t.path, declText(d, resolved(s, d.value, null)));
    }
    return c.findings(rule, FIX);
  },
};
