import type { Rule } from "../types.js";
import { px } from "../css-values.js";
import { CORNERS, cornerProperty, ellipticalCorners, expandBorderRadius, parseCornerRadius, resolveRadii, type Corner } from "../resolve/radius.js";
import { at, Collector, resolved, sources, targetOf } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-020", severity: "error",
  check(s) {
    const c = new Collector();
    const rootFontSize = px(s.elements[0]?.computed["font-size"]) ?? 16;
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t || (src.kind === "rule" && src.elements.length === 0 && src.pseudo.size > 0)) continue;
      const corners: Partial<Record<Corner, string>> = {};
      const at0 = t.element?.index ?? null;
      for (const d of src.decls) {
        const v = resolved(s, d.value, at0);
        if (d.name === "border-radius") Object.assign(corners, expandBorderRadius(v) ?? {});
        for (const k of CORNERS) if (d.name === cornerProperty(k)) corners[k] = v;
      }
      if (Object.keys(corners).length === 0) continue;
      let hit: { path: string; detail: string } | null = null;
      for (const i of src.elements) {
        const e = s.elements[i];
        if (!e.box) continue;
        const r = resolveRadii(corners, e.box, { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize });
        const bad = r ? ellipticalCorners(r) : [];
        if (bad.length) {
          const text = (k: Corner) => `${corners[k]} → ${r![k].x.toFixed(2)}px × ${r![k].y.toFixed(2)}px`;
          const same = bad.length === 4 && bad.every((k) => text(k) === text(bad[0]));
          const list = same ? `border-radius (all corners): ${text(bad[0])}` : bad.map((k) => `${cornerProperty(k)}: ${text(k)}`).join(", ");
          hit = { path: e.path, detail: `${list} on a ${e.box!.w.toFixed(2)}×${e.box!.h.toFixed(2)} box` };
          break;
        }
      }
      if (!hit && src.elements.length === 0) {
        // no box: only radii that differ whatever the box is
        const bad = (Object.entries(corners) as [Corner, string][]).filter(([, v]) => {
          const p = parseCornerRadius(v);
          return !!p && px(p[0]) !== null && px(p[1]) !== null && Math.abs(px(p[0])! - px(p[1])!) > 0.5;
        });
        if (bad.length) hit = { path: t.path, detail: bad.map(([k, v]) => `${cornerProperty(k)}: ${v}`).join(", ") };
      }
      if (hit) c.add(hit.path, hit.detail + at(src, t));
    }
    return c.findings(rule, "Use one px radius per corner (circular corners); for a pill use half the height. A % radius on a non-square box and the / syntax draw ellipses.");
  },
};
