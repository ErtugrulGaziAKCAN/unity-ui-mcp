import { px } from "../css-values.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign, textElements } from "./util.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Layout noise allowed at a box edge (CSS px). */
const EPS = 0.05;

const clips = (e: SnapElement) => /^(hidden|clip)$/.test(e.computed["overflow-x"] ?? "") || /^(hidden|clip)$/.test(e.computed["overflow-y"] ?? "");
const scrolls = (e: SnapElement) => /^(auto|scroll)$/.test(e.computed["overflow-x"] ?? "") || /^(auto|scroll)$/.test(e.computed["overflow-y"] ?? "");

/** How much the element's transforms (its own and its ancestors') scale it vertically: its drawn height over its layout height. */
const scaleOf = (e: SnapElement) => (e.box && e.size && e.size.h > 0 && e.box.h > 0 ? e.box.h / e.size.h : 1);

/** The padding box (where overflow clips): the border box without its borders (CSS px, page coordinates, transforms applied). */
function paddingBox(e: SnapElement): { top: number; bottom: number } | null {
  if (!e.box) return null;
  const f = scaleOf(e);
  const t = (px(e.computed["border-top-width"]) ?? 0) * f, b = (px(e.computed["border-bottom-width"]) ?? 0) * f;
  return { top: e.box.y + t, bottom: e.box.y + e.box.h - b };
}

/**
 * Whether a clipping box holds content besides the text's own block: a drawn descendant that is neither an ancestor of the
 * text nor inside it (a list of rows, an icon beside a label). Only then can a line it cuts be content that runs off a box
 * tall enough for the text (a list cut at the screen's edge); a box that holds only the text must hold its line boxes.
 */
function holdsMore(s: DomSnapshot, clip: SnapElement, text: SnapElement): boolean {
  const chain = new Set<number>();
  for (let a: SnapElement | undefined = text; a; a = a.parent >= 0 ? s.elements[a.parent] : undefined) chain.add(a.index);
  const stack = [...clip.children];
  while (stack.length) {
    const d = s.elements[stack.pop()!];
    if (d.index === text.index) continue; // the text's own subtree is its block
    if (!chain.has(d.index) && d.rendered && d.box && d.box.w > 0 && d.box.h > 0) return true;
    stack.push(...d.children);
  }
  return false;
}

/**
 * Text cut by a box that is shorter than its lines: an element (the text's own box or an ancestor) with `overflow: hidden`
 * or `clip` cuts a line box of the text across its top or bottom edge. Both renderers clip at the same edge, so the cut
 * ascenders and descenders (accents, descenders of g, ş, ç) pass verify unnoticed. Boxes, lines and line heights are compared
 * with the transforms applied. A box that ends between two lines (a clean cut), content that merely runs off a box taller than
 * the text's lines together with other content (a list cut at the screen's edge) and content inside a scroll area are not
 * judged; a box that holds only the text must hold its line boxes, however the text sits in it.
 */
export const rule: Rule = {
  id: "U-CSS-047", severity: "error",
  check(s: DomSnapshot, kit) {
    const out = [];
    const where = kit.viewports.map((v) => `${v[0]}×${v[1]}`).join(", ");
    for (const e of textElements(s)) {
      if (!e.lines?.length || nonDesign(s)[e.index] || isExternal(s, e.index) || e.computed.visibility === "hidden") continue;
      // the line height as drawn: the box and line rects are measured with every transform applied, so the line height is too
      const lh = (px(e.computed["line-height"]) ?? (px(e.computed["font-size"]) ?? 0) * 1.2) * scaleOf(e);
      if (!(lh > 0)) continue;
      // each line's line box: the line height around the middle of its content area (half-leading above and below); a block
      // whose first line starts at its content box's top (within a pixel) has its lines exactly there, one line height each
      const mid = e.lines.map((l) => (l.top + l.bottom) / 2 - lh / 2);
      const top = e.box ? e.box.y + ((px(e.computed["border-top-width"]) ?? 0) + (px(e.computed["padding-top"]) ?? 0)) * scaleOf(e) : NaN;
      const exact = !e.computed.display.startsWith("inline") && Math.abs(mid[0] - top) < 1;
      const boxes = mid.map((m, i) => { const t = exact ? top + i * lh : m; return { top: t, bottom: t + lh }; });
      const needed = boxes.length * lh;
      for (let a: SnapElement | undefined = e; a; a = a.parent >= 0 ? s.elements[a.parent] : undefined) {
        if (a !== e && scrolls(a)) break; // a scroll area clips its content by scrolling: what is outside it is not judged
        if (!clips(a)) continue;
        const clip = paddingBox(a);
        if (!clip) continue;
        const height = clip.bottom - clip.top;
        // room for every line, and other content in it: the text runs off with that content (a list cut at the screen's edge)
        if (height >= needed - EPS && holdsMore(s, a, e)) continue;
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
