import { CSS_WIDE, px } from "./css-values.js";
import { designChildren } from "./repeat.js";
import type { DomSnapshot, SnapElement } from "./snapshot.js";

/**
 * Promotion of a lone inline element to a block, shared by lint (U-CSS-009) and the IR extraction. UI Toolkit has no
 * inline flow, so an inline element that is the only content of a block container compiles as a block (a keyed text
 * run, or a link alone in a list item). That is exact only when nothing tells the inline box from the block: no box
 * paint, no transform or opacity, and the parent's font metrics (the CSS line box keeps the parent's strut). Otherwise
 * the exporter leaves it inline (the compiler rejects it) and lint reports it.
 */

/**
 * The element is its parent's only design child and the parent has no text of its own. Siblings hidden in the
 * default state count: the compiler keeps an element hidden in base in its tree, and a state can show it.
 */
export function onlyDesignChild(s: DomSnapshot, e: SnapElement): boolean {
  if (e.parent < 0) return false;
  const p = s.elements[e.parent];
  const kids = designChildren(s, p);
  return p.texts.length === 0 && kids.length === 1 && kids[0] === e.index;
}

/** Declarations of a property on an element, every layer ("base" or a layer key), with var() resolved. */
export type LayerValues = (i: number, prop: string) => { layer: string; value: string }[];

const SIDES = ["top", "right", "bottom", "left"];
const ZERO = (v: string) => /^-?0+(\.0+)?(px|%)?$/i.test(v.trim()) || px(v) === 0;
const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|#0{4}(0{4})?)$/i;
/** Box paint, transforms and opacity: their initial values (anything else draws or moves the box). */
const PAINT: [string, (v: string) => boolean][] = [
  ["background-color", (v) => TRANSPARENT.test(v)],
  ["background-image", (v) => v === "none"],
  ["box-shadow", (v) => v === "none"],
  ...SIDES.flatMap((sd): [string, (v: string) => boolean][] => [
    [`padding-${sd}`, ZERO], [`margin-${sd}`, ZERO], [`border-${sd}-width`, ZERO], [`border-${sd}-style`, (v) => /^(none|hidden)$/.test(v)],
  ]),
  ...["top-left", "top-right", "bottom-right", "bottom-left"].map((c): [string, (v: string) => boolean] => [`border-${c}-radius`, (v) => v.split(/\s+/).every(ZERO)]),
  ["outline-style", (v) => v === "none"],
  ["transform", (v) => v === "none"], ["translate", (v) => v === "none"], ["rotate", (v) => v === "none"], ["scale", (v) => v === "none"],
  ["opacity", (v) => Number(v) === 1],
];
/** The font metrics of the line: the parent's strut sets the line box. */
export const LINE_FONT = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"];

/**
 * Why the inline element would render differently as a block; empty when the promotion is exact. Reads the default
 * render (computed values, browser defaults included) and every layer's declarations.
 */
export function promotionDifferences(s: DomSnapshot, e: SnapElement, values: LayerValues): string[] {
  const out: string[] = [];
  const parent = s.elements[e.parent];
  for (const [prop, initial] of PAINT) {
    // computed: a border width is 0 without a visible style, as the browser computes it
    const cv = (e.computed[prop] ?? "").trim().toLowerCase();
    if (cv && !initial(cv)) out.push(`${prop}: ${e.computed[prop]}`);
    // the base layer is the default render above; another layer (hover, a state, a breakpoint) may add paint
    for (const d of values(e.index, prop)) {
      const v = d.value.trim().toLowerCase();
      if (d.layer === "base" || v === "initial" || v === "unset" || initial(v)) continue;
      out.push(`${prop}: ${d.value} in layer ${d.layer}`);
    }
  }
  for (const prop of LINE_FONT) {
    if (e.computed[prop] !== parent.computed[prop]) { out.push(`${prop} ${e.computed[prop]} (the parent's is ${parent.computed[prop]})`); continue; }
    const own = values(e.index, prop).filter((d) => !/^(inherit|unset)$/i.test(d.value.trim()));
    for (const d of own) if (d.layer !== "base") out.push(`${prop}: ${d.value} in layer ${d.layer}`);
    // its own value stays when an ancestor's layer changes the parent's
    if (own.some((d) => d.layer === "base")) {
      for (let a = e.parent; a >= 0; a = s.elements[a].parent) {
        const layer = values(a, prop).find((d) => d.layer !== "base" && !CSS_WIDE.has(d.value.trim().toLowerCase()));
        if (layer) { out.push(`${prop} of the parent changes in layer ${layer.layer} while the element keeps its own`); break; }
      }
    }
  }
  return Array.from(new Set(out));
}
