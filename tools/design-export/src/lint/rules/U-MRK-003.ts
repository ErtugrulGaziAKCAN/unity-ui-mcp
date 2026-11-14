import { repeatOf, sampleHidden } from "../repeat.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

const INTERACTIVE = new Set(["button", "input", "select", "textarea", "a"]);
const ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "slider", "textbox", "combobox"]);

function why(e: { tag: string; ns: string; attrs: Record<string, string> }): string | null {
  const a = e.attrs;
  if (e.ns === "html" && INTERACTIVE.has(e.tag)) return `<${e.tag}>`;
  if (a.tabindex !== undefined) return `tabindex="${a.tabindex}"`;
  if (a["data-u-bind"] !== undefined) return `data-u-bind="${a["data-u-bind"]}"`;
  if (a["data-u-action"] !== undefined) return `data-u-action="${a["data-u-action"]}"`;
  if (a.onclick !== undefined) return "onclick";
  if (a.role !== undefined && ROLES.has(a.role.toLowerCase())) return `role="${a.role}"`;
  return null;
}

/**
 * Interactive and bound elements need a code-facing name (spec 5.2), and so does an element that some written-out items
 * of a repeat hide by markup and others show: its item view's visibility setter is named after it.
 */
export const rule: Rule = {
  id: "U-MRK-003", severity: "error",
  check(s) {
    const out = [];
    const shown = sampleHidden(s);
    for (const e of s.elements) {
      if (e.attrs["data-u-id"] !== undefined || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const w = why(e) ?? (shown.get(e.index) === e.index
        ? `an element that some written-out items of data-u-repeat "${repeatOf(s, e.index)}" hide by markup and others show (its item view's visibility setter is named after it)`
        : null);
      if (w) out.push(make(rule, e.path, `${w} has no data-u-id`,
        'Add data-u-id="<name>" (lowercase ASCII, e.g. open-inbox) to every interactive or bound element, and to every element the written-out items of a repeat hide in some items and show in others, so the generated view can reach it.'));
    }
    return out;
  },
};
