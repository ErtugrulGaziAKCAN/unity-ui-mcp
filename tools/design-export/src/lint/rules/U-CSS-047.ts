import { px } from "../css-values.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign, textElements } from "./util.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Layout noise allowed at a box edge (CSS px). */
const EPS = 0.05;

const clips = (e: SnapElement) => /^(hidden|clip)$/.test(e.computed["overflow-x"] ?? "") || /^(hidden|clip)$/.test(e.computed["overflow-y"] ?? "");
const scrolls = (e: SnapElement) => /^(auto|scroll)$/.test(e.computed["overflow-x"] ?? "") || /^(auto|scroll)$/.test(e.computed["overflow-y"] ?? "");

/** The padding box (where overflow clips): the border box without its borders (CSS px, page coordinates). */
function paddingBox(e: SnapElement): { top: number; bottom: number } | null {
  if (!e.box) return null;
  const t = px(e.computed["border-top-width"]) ?? 0, b = px(e.computed["border-bottom-width"]) ?? 0;
  return { top: e.box.y + t, bottom: e.box.y + e.box.h - b };
}

/**
 * Text cut by a box that is shorter than its lines: an element (the text's own box or an ancestor) with `overflow: hidden`
 * or `clip` cuts a line box of the text across its top or bottom edge, and is shorter than the lines the text has (one line
 * box per line, the text's line height each). Both renderers clip at the same edge, so the cut ascenders and descenders
 * (accents, descenders of g, ş, ç) pass verify unnoticed. A box that ends between two lines (a clean cut), content that
 * merely runs off a taller box (a list cut at the screen's edge) and content inside a scroll area are not judged.
 */
export const rule: Rule = {
  id: "U-CSS-047", severity: "error",
  check(s: DomSnapshot, kit) {
    const out = [];
    const where = kit.viewports.map((v) => `${v[0]}×${v[1]}`).join(", ");
    for (const e of textElements(s)) {
      if (!e.lines?.length || nonDesign(s)[e.index] || isExternal(s, e.index) || e.computed.visibility === "hidden") continue;
      const lh = px(e.computed["line-height"]) ?? (px(e.computed["font-size"]) ?? 0) * 1.2;
      if (!(lh > 0)) continue;
      // each line's line box: the line height around the middle of its content area (half-leading above and below); a block
      // whose first line starts at its content box's top (within a pixel) has its lines exactly there, one line height each
      const mid = e.lines.map((l) => (l.top + l.bottom) / 2 - lh / 2);
      const top = e.box ? e.box.y + (px(e.computed["border-top-width"]) ?? 0) + (px(e.computed["padding-top"]) ?? 0) : NaN;
      const exact = !e.computed.display.startsWith("inline") && Math.abs(mid[0] - top) < 1;
      const boxes = mid.map((m, i) => { const t = exact ? top + i * lh : m; return { top: t, bottom: t + lh }; });
      const needed = boxes.length * lh;
      for (let a: SnapElement | undefined = e; a; a = a.parent >= 0 ? s.elements[a.parent] : undefined) {
        if (a !== e && scrolls(a)) break; // a scroll area clips its content by scrolling: what is outside it is not judged
        if (!clips(a)) continue;
        const clip = paddingBox(a);
        if (!clip) continue;
        const height = clip.bottom - clip.top;
        if (height >= needed - EPS) continue; // room for every line: content that runs off it is not a clipped line box
        const cut = boxes.map((b) => ({
          top: b.top < clip.top - EPS && b.bottom > clip.top + EPS ? clip.top - b.top : 0,
          bottom: b.top < clip.bottom - EPS && b.bottom > clip.bottom + EPS ? b.bottom - clip.bottom : 0,
        }));
        const hit = cut.findIndex((c) => c.top > 0 || c.bottom > 0);
        if (hit < 0) continue;
        const c = cut[hit];
        const sides = [c.top > 0 ? `${r2(c.top)} px at the top` : "", c.bottom > 0 ? `${r2(c.bottom)} px at the bottom` : ""].filter(Boolean).join(" and ");
        const owner = a === e ? "its own box" : a.path;
        const lines = boxes.length === 1 ? "its line" : `line ${hit + 1} of its ${boxes.length} lines`;
        out.push(make(rule, e.path,
          `${owner} (overflow: ${a.computed["overflow-y"] === "visible" ? a.computed["overflow-x"] : a.computed["overflow-y"]}) is ${r2(height)} px tall and cuts ` +
          `the ${r2(lh)} px line box of ${lines} by ${sides}, at every declared viewport (${where}): glyphs that reach into it (accents, descenders) are clipped ` +
          `in the browser and in Unity alike, so verify does not notice`,
          `Make the box at least the line height (${boxes.length === 1 ? `${r2(lh)} px` : `${boxes.length} lines × ${r2(lh)} px = ${r2(needed)} px`}), ` +
          `or use a text style whose line height fits the box, or remove overflow: hidden from it. To show fewer lines, make the box a whole number of line heights.`));
        break;
      }
    }
    return out;
  },
};
