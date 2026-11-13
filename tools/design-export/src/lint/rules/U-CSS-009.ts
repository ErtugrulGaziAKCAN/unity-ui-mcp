import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import { layoutOf } from "../layout.js";
import { isTextElement, runPlans } from "../text-runs.js";
import { onlyDesignChild, promotionDifferences, type LayerValues } from "../promote.js";
import { Collector, inFlow, isExternal, nonDesign, resolved } from "./util.js";

const RICH = new Set(["b", "strong", "i", "em", "span"]);
/** Inherited properties a rich tag must not change (besides color and font-size). */
const SAME_AS_PARENT = ["font-family", "letter-spacing", "word-spacing", "text-transform", "text-shadow", "font-variant-caps", "white-space-collapse", "text-wrap-mode"];
/** Non-inherited properties a rich tag must leave at their initial value. */
const INITIAL: Record<string, string> = {
  "background-color": "rgba(0, 0, 0, 0)", "background-image": "none", "box-shadow": "none", "opacity": "1", "transform": "none",
  "vertical-align": "baseline", "text-decoration-line": "none", "outline-style": "none", "filter": "none",
  "border-top-width": "0px", "border-right-width": "0px", "border-bottom-width": "0px", "border-left-width": "0px",
  "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px",
  "margin-top": "0px", "margin-right": "0px", "margin-bottom": "0px", "margin-left": "0px",
};

const RICH_FIX = "Inside a line of text use only b/strong, i/em, br and span with color or font-size; give other elements display: block or flex, or split the text into separate elements.";

/** Box properties an inline element draws per line fragment, unlike a block. */
const BOX = ["background-color", "background-image", "box-shadow", "transform", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left"];

function richEffects(e: SnapElement, parent: SnapElement): string[] {
  const out: string[] = [];
  const same = [...SAME_AS_PARENT];
  if (e.tag !== "b" && e.tag !== "strong") same.push("font-weight");
  if (e.tag !== "i" && e.tag !== "em") same.push("font-style");
  for (const p of same) if (e.computed[p] !== parent.computed[p]) out.push(`${p}: ${e.computed[p]}`);
  for (const [p, v] of Object.entries(INITIAL)) if (e.computed[p] !== v) out.push(`${p}: ${e.computed[p]}`);
  return out;
}

/** Declarations of a property on an element in every layer, from the extraction's cascade (var() resolved). */
export const layerValues = (s: DomSnapshot): LayerValues => (i, prop) =>
  layoutOf(s).cands(i).filter((c) => c.prop === prop).map((c) => ({ layer: c.key, value: resolved(s, c.entry.value, i) }));

const BLOCK_FIX = "Set display: block on the child, or make the parent display: flex.";

/**
 * Only TextCore rich text tags (b, i, color, size) may sit inside a line of text, and UI Toolkit has no inline flow:
 * an inline element that does not become part of one text compiles to its own node, which the compiler accepts only
 * as the only content of a block container promoted to a block where that renders the same (lint/promote.ts).
 */
export const rule: Rule = {
  id: "U-CSS-009", severity: "error",
  check(s) {
    const c = new Collector();
    const fixes = new Map<string, string>();
    const add = (path: string, detail: string, fix = RICH_FIX) => { c.add(path, detail); if (!fixes.has(path)) fixes.set(path, fix); };
    const runs = runPlans(s);
    for (const e of s.elements) {
      if (!inFlow(e) || e.parent < 0 || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      // a line break is part of the text; unsupported elements are U-CSS-029's
      if (e.tag === "br" || !cssSupport.isAllowedElement(e.tag, e.attrs)) continue;
      const parent = s.elements[e.parent];
      // children of a display:none root are not blockified while hidden: their layout is not known here
      if (parent.computed.display === "none") continue;
      // a flex item is blockified; nothing flows inline
      if (layoutOf(s).visibleDisplay(parent.index) === "flex") continue;
      const run = runs.get(parent.index);
      const merged = isTextElement(s, parent) && !(run?.kind === "single" && run.child === e.index) && run?.kind !== "row";
      if (onlyDesignChild(s, e) && !merged) {
        // the only content of a block container (e.g. <li><a>…</a></li>, a keyed span alone in a paragraph): its own node
        const box = BOX.filter((p) => e.computed[p] !== INITIAL[p]);
        if (box.length) { add(e.path, `<${e.tag}> (display: ${e.computed.display}) draws an inline box: ${box.map((p) => `${p}: ${e.computed[p]}`).join(", ")}`, BLOCK_FIX); continue; }
        if (e.computed.display !== "inline") { add(e.path, `<${e.tag}> is display: ${e.computed.display}, the only content of a block container: an inline box in a line, which UI Toolkit cannot lay out`, BLOCK_FIX); continue; }
        if (!isTextElement(s, e)) { add(e.path, `<${e.tag}> is display: inline, the only content of a block container, and holds elements that are not inline text`, BLOCK_FIX); continue; }
        const diffs = promotionDifferences(s, e, layerValues(s));
        if (diffs.length) add(e.path, `<${e.tag}> is display: inline, the only content of a block container; as a block (UI Toolkit has no inline flow) it would render differently: ${diffs.join(", ")}`, BLOCK_FIX);
        continue;
      }
      if (run?.kind === "row") continue; // keyed runs in a row: U-MRK-009 judges them
      if (!merged) {
        // next to other content (a hidden sibling counts: the compiler keeps it) in a container that is not one text
        add(e.path, `<${e.tag}> is display: ${e.computed.display} in a block container that does not compile as one text (it holds other elements or keyed text); UI Toolkit has no inline flow`, BLOCK_FIX);
        continue;
      }
      if (!RICH.has(e.tag) || e.computed.display !== "inline") { add(e.path, `<${e.tag}> is display: ${e.computed.display} inside a line of text`); continue; }
      const fx = richEffects(e, parent);
      if (fx.length) add(e.path, `<${e.tag}> inside text changes ${fx.join(", ")} (rich text allows only color and font-size${e.tag === "b" || e.tag === "strong" ? ", and bold" : e.tag === "i" || e.tag === "em" ? ", and italic" : ""})`);
    }
    return c.findings(rule, (path) => fixes.get(path) ?? RICH_FIX);
  },
};
