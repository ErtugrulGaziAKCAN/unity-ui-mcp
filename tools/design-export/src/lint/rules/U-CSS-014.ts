import { effectProblems } from "../../extract/effects.js";
import { StyleExtractor } from "../../extract/styles.js";
import type { Rule } from "../types.js";
import { Collector, inSvg, isExternal, nonDesign, sourcesOf } from "./util.js";

const EFFECT = /^(box-shadow|background-image)$/;

/**
 * Shadows and background images the exporter cannot bake (it shares effectProblems with this rule): a transition of
 * box-shadow or background-image (the baked image is swapped per layer), more than one image when one is a url(), a
 * gradient that does not fill the element, or gradient syntax beyond sRGB colour stops.
 */
export const rule: Rule = {
  id: "U-CSS-014", severity: "error",
  check(s) {
    const c = new Collector();
    const candidates = s.elements.filter((e) => !nonDesign(s)[e.index] && !isExternal(s, e.index) && !inSvg(s)[e.index] &&
      (sourcesOf(s)[e.index] ?? []).some((src) => src.decls.some((d) => EFFECT.test(d.name) || (d.invalid && /^background$/.test(d.name)))));
    if (!candidates.length) return [];
    // layer keys name ancestors by id; lint needs no real ids, only distinct ones
    const ex = new StyleExtractor(s, { ids: new Map(s.elements.map((e) => [e.index, e.attrs["data-u-id"] ?? `e${e.index}`])) });
    for (const e of candidates) {
      let problems: string[];
      try { problems = effectProblems(ex, e.index); } catch { continue; } // selectors other rules reject
      if (problems.length) c.add(e.path, problems.join("; "));
    }
    return c.findings(rule,
      "Transition opacity or transform instead of box-shadow or background-image (the baked shadow or gradient is swapped per state); " +
      "use one url() image per element (put others in child elements); let a gradient fill the element (background-size auto or 100%, " +
      "background-position in % or keywords); write gradient colours as sRGB colour stops (no colour space, no hints).");
  },
};
