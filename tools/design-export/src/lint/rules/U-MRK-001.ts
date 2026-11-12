import type { Rule } from "../types.js";
import { make } from "./util.js";

/** Exactly one screen root. */
export const rule: Rule = {
  id: "U-MRK-001", severity: "error",
  check(s) {
    const roots = s.elements.filter((e) => e.attrs["data-u-screen"] !== undefined);
    if (roots.length === 1) return [];
    const detail = roots.length === 0 ? "no element has data-u-screen" : `${roots.length} elements have data-u-screen: ${roots.map((e) => e.path).join(", ")}`;
    return [make(rule, "document", detail, 'Put data-u-screen="<screen.id>" on exactly one element, the root of the screen; design other screens in their own files.')];
  },
};
