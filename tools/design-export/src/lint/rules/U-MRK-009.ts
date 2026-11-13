import { runPlans } from "../text-runs.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/**
 * An inline element with a key, bind, id or action is its own text node. A paragraph may hold one of them, or
 * several on one line with nothing between them (they become a row); text, other inline tags or spaces next to
 * them would render differently once split, so they are rejected.
 */
export const rule: Rule = {
  id: "U-MRK-009", severity: "error",
  check(s) {
    const out = [];
    for (const [i, p] of runPlans(s)) if (p.kind === "error") out.push(make(rule, s.elements[i].path, p.detail, p.fix));
    return out;
  },
};
