import { px } from "../css-values.js";
import type { SnapElement } from "../snapshot.js";
import { isKeyed, promotedRuns } from "../text-runs.js";
import { describeStyle, matchRichStyle, matchTextStyle, nearestTextStyle } from "../text-styles.js";
import type { Rule } from "../types.js";
import { at, Collector, inFlow, resolved, sources, targetOf, textElements } from "./util.js";

const WEIGHT_KW: Record<string, number> = { normal: 400, bold: 700 };

/** Text styles come from text-styles.json, matched numerically (whole-pixel sizes and line heights). */
export const rule: Rule = {
  id: "U-CSS-016", severity: "error",
  check(s, kit, _b, ctx) {
    const styles = ctx.textStyles;
    const c = new Collector();
    const blocks = new Set<SnapElement>();
    const promoted = promotedRuns(s);
    for (const e of textElements(s)) {
      if (e.tag === "option") continue; // drawn by the native popup, not the screen
      // a keyed inline run is its own text node: a full kit style, line height included
      if (!inFlow(e) || e.parent < 0 || promoted.has(e.index) || isKeyed(e)) { blocks.add(e); continue; }
      // rich text: the paragraph sets the line; the tag may change size and weight within kit styles
      let k = e.parent;
      while (k >= 0 && inFlow(s.elements[k])) k = s.elements[k].parent;
      if (k >= 0) blocks.add(s.elements[k]);
      const p = s.elements[e.parent];
      if (p.computed["font-size"] === e.computed["font-size"] && p.computed["font-weight"] === e.computed["font-weight"]) continue;
      const size = px(e.computed["font-size"]), w = Number(e.computed["font-weight"]);
      if (size !== null && !matchRichStyle(styles, size, w)) c.add(e.path, `rich text ${e.computed["font-size"]}, weight ${w} is no kit style's size and weight`);
    }
    for (const e of blocks) {
      const size = px(e.computed["font-size"]), lh = px(e.computed["line-height"]), w = Number(e.computed["font-weight"]);
      if (size === null || matchTextStyle(styles, size, lh, w)) continue;
      const n = nearestTextStyle(styles, size, lh, w);
      c.add(e.path, `text style ${e.computed["font-size"]} / ${e.computed["line-height"]} / ${w} is not in ${kit.textStyles}${n ? ` (nearest: ${describeStyle(n)})` : ""}`);
    }
    // layers the current render does not show (hover, breakpoints, states): each declared value must be a kit value
    const sizes = styles.map((x) => x.fontSize), heights = styles.map((x) => x.lineHeight), weights = new Set(styles.map((x) => x.weight));
    const near = (list: number[], v: number) => list.some((x) => Math.abs(x - v) <= Math.max(0.001, x * 1e-5));
    for (const src of sources(s)) {
      if (src.kind !== "rule" || !(src.rule!.media.length || src.rule!.selectors.some((x) => x.reach !== x.text))) continue;
      const t = targetOf(s, src);
      if (!t) continue;
      for (const d of src.decls) {
        const v = resolved(s, d.value, t.element?.index ?? null).trim().toLowerCase();
        const n = px(v);
        if (d.name === "font-size" && n !== null && !near(sizes, n)) c.add(t.path, `font-size: ${v}${at(src, t)}`);
        if (d.name === "line-height" && (v === "normal" || (n !== null && !near(heights, n)))) c.add(t.path, `line-height: ${v}${at(src, t)}`);
        if (d.name === "font-weight" && !weights.has(WEIGHT_KW[v] ?? Number(v)) && !/^(inherit|initial|unset|revert)$/.test(v)) c.add(t.path, `font-weight: ${v}${at(src, t)}`);
      }
    }
    return c.findings(rule, `Use a kit text style (${kit.textStyles}): font-size, line-height and font-weight of one entry, e.g. ${styles.slice(0, 3).map(describeStyle).join(", ")}.`);
  },
};
