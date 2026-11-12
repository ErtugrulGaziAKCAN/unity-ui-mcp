import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

const INTERACTIVE = new Set(["button", "input", "select", "textarea", "a"]);

/** Interactive elements need a code-facing name. */
export const rule: Rule = {
  id: "U-MRK-003", severity: "error",
  check(s) {
    return s.elements
      .filter((e) => ((e.ns === "html" && INTERACTIVE.has(e.tag)) || e.attrs.tabindex !== undefined) && e.attrs["data-u-id"] === undefined
        && !isExternal(s, e.index) && !nonDesign(s)[e.index])
      .map((e) => make(rule, e.path, `<${e.tag}${e.attrs.tabindex !== undefined ? ` tabindex="${e.attrs.tabindex}"` : ""}> has no data-u-id`,
        'Add data-u-id="<name>" (lowercase ASCII, e.g. open-inbox) so the generated view can reach the element.'));
  },
};
