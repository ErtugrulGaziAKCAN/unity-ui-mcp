import type { KitConfig } from "../../kit.js";
import { logicalViewport } from "../../viewport.js";
import { px } from "../css-values.js";
import { layoutOf } from "../layout.js";
import type { DomSnapshot } from "../snapshot.js";
import type { Rule } from "../types.js";
import { kitScales } from "./U-CSS-040.js";
import { make } from "./util.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Chromium's width of a border of `w` CSS px at device scale `a`: whole device px, halves up, at least one (as the golden lays it out). */
export const browserBorder = (w: number, a: number) => (w > 0 ? Math.max(1, Math.floor(w * a + 0.5 + 1e-4)) : 0);

/**
 * UI Toolkit's drawn width of the same border at a scaled viewport: laid out at the next exact scale up `e` (whole device
 * px there, halves up), drawn through the root scale a / e.
 */
export const toolkitBorder = (w: number, a: number, e: number) => (w > 0 ? Math.max(1, Math.floor(w * e + 0.5 + 1e-4)) * (a / e) : 0);

/** The exact scale a scaled viewport lays out at: the next exact scale up, else the largest. */
export function layoutScaleFor(kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch">, a: number): number {
  const exact = kitScales(kit).map((x) => x.scale).sort((p, q) => p - q);
  return exact.find((e) => e >= a - 1e-9) ?? exact[exact.length - 1] ?? a;
}

function borderWidth(s: DomSnapshot, i: number, side: "left" | "top"): number {
  const k = s.elements[i].computed;
  if (/^(none|hidden)$/.test(k[`border-${side}-style`] ?? "none")) return 0;
  return px(k[`border-${side}-width`]) ?? 0;
}

/**
 * Nested borders at a scaled viewport: the screen lays out at the next exact scale up and draws scaled, so every border
 * is drawn at its exact-scale whole device px times the root scale (a 4 px border 2.5 device px at 1600×900), where
 * Chromium draws whole device px at the actual scale (3). Each bordered level moves what is inside it by the difference,
 * and the differences add up (docs/findings/viewport-classes.md, nested borders): past 1 device px the content fails the
 * box limit. Warns once per element whose own border takes the drift of its content past 1 device px at a declared
 * scaled viewport, naming the bordered levels and the drift.
 */
export const rule: Rule = {
  id: "W-CSS-001", severity: "warning",
  check(s, kit) {
    const scaled = (kit.scaledViewports ?? []).map((v) => {
      const a = logicalViewport(v, kit.reference, kit.screenMatch).scale;
      return { v, a, e: layoutScaleFor(kit, a) };
    });
    if (!scaled.length) return [];
    const L = layoutOf(s);
    const out = [];
    for (const e of s.elements) {
      if (!L.inScreen(e.index) || !e.rendered || e.computed.display === "none") continue;
      const own = (["left", "top"] as const).some((side) => borderWidth(s, e.index, side) > 0);
      if (!own) continue;
      for (const side of ["left", "top"] as const) {
        const chain: number[] = [];
        for (let j = e.index; j >= 0 && L.inScreen(j); j = s.elements[j].parent) if (borderWidth(s, j, side) > 0) chain.push(j);
        if (chain.length < 2 || borderWidth(s, e.index, side) <= 0) continue;
        const drift = (levels: number[], x: { a: number; e: number }) =>
          levels.reduce((sum, j) => { const w = borderWidth(s, j, side); return sum + toolkitBorder(w, x.a, x.e) - browserBorder(w, x.a); }, 0);
        // only where this element's border takes the drift past 1 device px (its ancestors' alone stay within it)
        const over = scaled.filter((x) => Math.abs(drift(chain, x)) > 1 + 1e-6 && Math.abs(drift(chain.slice(1), x)) <= 1 + 1e-6);
        if (!over.length) continue;
        const names = chain.slice().reverse().map((j) => `${L.name(j)} (${borderWidth(s, j, side)}px)`).join(" > ");
        const at = over.map((x) => `${round2(drift(chain, x))} device px at ${x.v[0]}×${x.v[1]}`).join(", ");
        out.push(make(rule, e.path, `${chain.length} nested ${side} borders, ${names}: their content is drawn ${at} from where the browser draws it ` +
          `(each border on whole device px of the exact scale, drawn scaled, where the browser draws whole device px)`,
          `Nest fewer bordered boxes (three levels of 4px borders draw their content 1.5 device px off at 1600×900, two levels 1), ` +
          `for example by drawing an inner frame on a sibling layer instead of inside the outer one, or use border widths whose ` +
          `drawn widths agree at the scaled viewports the kit declares.`));
        break;
      }
    }
    return out;
  },
};
