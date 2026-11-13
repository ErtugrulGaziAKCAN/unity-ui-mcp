import type { Rule } from "../types.js";
import { Collector, isExternal, nonDesign } from "./util.js";

/**
 * An inline SVG painted with currentColor compiles to a tinted vector image, so it follows the text colour in every
 * state; a tint would also recolour any part painted with a fixed colour.
 */
export const rule: Rule = {
  id: "U-CSS-031", severity: "error",
  check(s) {
    const c = new Collector();
    for (const e of s.elements) {
      if (e.svgPaint !== "mixed" || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      c.add(e.path, "the inline SVG paints some shapes with currentColor and others with fixed colours");
    }
    return c.findings(rule, "Paint every shape of the icon with currentColor (it then follows the colour of its element in every state) or every shape with fixed colours.");
  },
};
