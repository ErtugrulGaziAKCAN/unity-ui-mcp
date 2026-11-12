import { px } from "../css-values.js";
import { closeStops, findGradients } from "../resolve/gradient.js";
import type { Rule } from "../types.js";
import { at, Collector, resolved, sources, targetOf } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-022", severity: "error",
  check(s) {
    const c = new Collector();
    const rootFontSize = px(s.elements[0]?.computed["font-size"]) ?? 16;
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t || (src.kind === "rule" && src.elements.length === 0 && src.pseudo.size > 0)) continue;
      for (const d of src.decls) {
        if (d.name !== "background-image" && !(d.invalid && d.name === "background")) continue;
        const targets = src.elements.length ? src.elements.map((i) => s.elements[i]) : [null];
        for (const e of targets) {
          const v = resolved(s, d.value, e?.index ?? null);
          const close = findGradients(v).filter((g) => !g.repeating).flatMap((g) => closeStops(g, e?.box ?? null, 1 / 64, { fontSize: px(e?.computed["font-size"]) ?? undefined, rootFontSize }));
          if (!close.length) continue;
          c.add(e ? e.path : t.path, close.map((x) => `stops ${x.a.color} ${x.a.position ?? ""} → ${x.b.color} ${x.b.position ?? ""} are ${(x.gap * 100).toFixed(2)}% apart (min 1.5625%)`).join(", ") + at(src, t));
          break;
        }
      }
    }
    return c.findings(rule, "Split the area into two elements at a hard edge, or spread each colour change over at least 1/64 of the gradient length (the SVG importer bakes a 64-step ramp).");
  },
};
