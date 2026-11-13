import { repeatIssues } from "../repeat.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

/** A data-u-repeat container holds only its items, every item shares the template's structure, and the mode is list or inline. */
export const rule: Rule = {
  id: "U-MRK-010", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      const issues = repeatIssues(s, e.index);
      if (issues.length) out.push(make(rule, e.path, issues.join("; "),
        "Put only the repeated items in the container (the first with data-u-repeat, the samples after it with the same tag and classes), give every sample the template's elements, ids, keys and binds (only texts and is-* classes may differ), and use data-u-repeat-mode list or inline."));
    }
    return out;
  },
};
