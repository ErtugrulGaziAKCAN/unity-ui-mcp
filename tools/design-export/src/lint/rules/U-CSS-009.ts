import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import type { SnapElement } from "../snapshot.js";
import { Collector, inFlow, isExternal, nonDesign } from "./util.js";

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

function richEffects(e: SnapElement, parent: SnapElement): string[] {
  const out: string[] = [];
  const same = [...SAME_AS_PARENT];
  if (e.tag !== "b" && e.tag !== "strong") same.push("font-weight");
  if (e.tag !== "i" && e.tag !== "em") same.push("font-style");
  for (const p of same) if (e.computed[p] !== parent.computed[p]) out.push(`${p}: ${e.computed[p]}`);
  for (const [p, v] of Object.entries(INITIAL)) if (e.computed[p] !== v) out.push(`${p}: ${e.computed[p]}`);
  return out;
}

/** Only TextCore rich text tags (b, i, color, size) may sit inside a line of text. */
export const rule: Rule = {
  id: "U-CSS-009", severity: "error",
  check(s) {
    const c = new Collector();
    for (const e of s.elements) {
      if (!inFlow(e) || e.parent < 0 || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      // a line break is part of the text; unsupported elements are U-CSS-029's
      if (e.tag === "br" || !cssSupport.isAllowedElement(e.tag, e.attrs)) continue;
      const parent = s.elements[e.parent];
      // children of a display:none root are not blockified while hidden: their layout is not known here
      if (parent.computed.display === "none") continue;
      if (!RICH.has(e.tag) || e.computed.display !== "inline") { c.add(e.path, `<${e.tag}> is display: ${e.computed.display} inside a line of text`); continue; }
      const fx = richEffects(e, parent);
      if (fx.length) c.add(e.path, `<${e.tag}> inside text changes ${fx.join(", ")} (rich text allows only color and font-size${e.tag === "b" || e.tag === "strong" ? ", and bold" : e.tag === "i" || e.tag === "em" ? ", and italic" : ""})`);
    }
    return c.findings(rule, "Inside a line of text use only b/strong, i/em, br and span with color or font-size; make other elements flex items of a flex container, or split the text into separate elements.");
  },
};
