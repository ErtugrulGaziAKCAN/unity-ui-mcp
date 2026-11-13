import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { Collector, inSvg, isExternal, nonDesign } from "./util.js";

/** Tags owned by U-DC-002 (Design Component templating). */
const DC_TAGS = new Set(["sc-for", "sc-if", "dc-import", "x-import"]);

export const rule: Rule = {
  id: "U-CSS-029", severity: "error",
  check(s) {
    const c = new Collector();
    for (const e of s.elements) {
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      if (e.shadowRoot) c.add(e.path, `<${e.tag}> has a ${e.shadowRoot} shadow root: its content is not part of the design`);
      if (e.ns === "svg") { if (e.tag.toLowerCase() === "foreignobject") c.add(e.path, "<foreignObject> puts HTML inside an SVG icon"); continue; }
      if (inSvg(s)[e.index] || DC_TAGS.has(e.tag)) continue;
      if (!cssSupport.isAllowedElement(e.tag, e.attrs)) {
        c.add(e.path, e.tag === "input" ? `<input type="${e.attrs.type}"> has no UI Toolkit control` : `<${e.tag}> has no UI Toolkit equivalent`);
      }
    }
    return c.findings(rule,
      `Use only ${cssSupport.elements.join(", ")}, input[type=${cssSupport.inputTypes.join("|")}] and inline <svg>; draw tables, media and canvases with those (images as <img>), and keep everything in the light DOM.`);
  },
};
