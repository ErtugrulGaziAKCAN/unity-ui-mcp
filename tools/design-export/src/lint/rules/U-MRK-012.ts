import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

/**
 * An element with data-u-action inside another one with data-u-action: nested interactive content is invalid HTML, and in
 * UI Toolkit one click on the inner element would raise both actions (the compiler rejects it too).
 */
export const rule: Rule = {
  id: "U-MRK-012", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      const action = e.attrs["data-u-action"];
      if (action === undefined || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      for (let p = e.parent; p >= 0; p = s.elements[p].parent) {
        const outer = s.elements[p].attrs["data-u-action"];
        if (outer === undefined) continue;
        out.push(make(rule, e.path, `data-u-action="${action}" is inside data-u-action="${outer}" (${s.elements[p].path})`,
          "Move the action to one element. To keep a button inside a card, do not put the card's action on the card container: give the card (position: relative) " +
          "a full-size layer element (position: absolute; inset: 0) that carries the card's data-u-action, and put the button after it as its sibling (position: relative) " +
          "with its own action, so the button is drawn and pressed above the layer instead of inside another action."));
        break;
      }
    }
    return out;
  },
};
