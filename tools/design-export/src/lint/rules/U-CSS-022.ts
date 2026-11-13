import { px } from "../css-values.js";
import { closeStops, findGradients } from "../resolve/gradient.js";
import type { Rule } from "../types.js";
import { at, Collector, resolved, sources, targetOf } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-022", severity: "error",
  check(s) {
    const c = new Collector();
    const rootFontSize = s.rootFontSize;
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t || (src.kind === "rule" && src.elements.length === 0 && src.pseudo.size > 0)) continue;
      for (const d of src.decls) {
        if (d.name !== "background-image" && !(d.invalid && d.name === "background")) continue;
        const targets = src.elements.length ? src.elements.map((i) => s.elements[i]) : [null];
        for (const e of targets) {
          const v = resolved(s, d.value, e?.index ?? null);
          const grads = findGradients(v).filter((g) => !g.repeating);
          const close = grads.flatMap((g) => closeStops(g, e?.size ?? null, 1 / 64, { fontSize: px(e?.computed["font-size"]) ?? undefined, rootFontSize }));
          const hints = grads.flatMap((g) => g.hints);
          if (!close.length && !hints.length) continue;
          c.add(e ? e.path : t.path, [
            ...close.map((x) => `stops ${x.a.color} ${x.a.position ?? ""} → ${x.b.color} ${x.b.position ?? ""} are ${(x.gap * 100).toFixed(2)}% apart (min 1.5625%)`),
            ...hints.map((h) => `colour hint ${h} (SVG gradients have no hints)`),
          ].join(", ") + at(src, t));
          break;
        }
      }
    }
    return c.findings(rule, "Split the area into two elements at a hard edge, spread each colour change over at least 1/64 of the gradient length (the SVG importer bakes a 64-step ramp), and write colour hints as extra colour stops.");
  },
};
