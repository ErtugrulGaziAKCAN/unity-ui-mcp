import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";

/**
 * Unique data-u-id. Ids repeat legitimately in the written-out items of a list: every child of an element that has a
 * data-u-repeat child is its own id scope (template and samples share their inner ids).
 */
export const rule: Rule = {
  id: "U-MRK-002", severity: "error",
  check(s) {
    const repeatParents = new Set(s.elements.filter((e) => e.attrs["data-u-repeat"] !== undefined && e.parent >= 0).map((e) => e.parent));
    const scope = s.elements.map(() => -1);
    for (const e of s.elements) scope[e.index] = e.parent >= 0 && repeatParents.has(e.parent) ? e.index : e.parent >= 0 ? scope[e.parent] : -1;
    const seen = new Map<string, number>();
    const out = [];
    for (const e of s.elements) {
      const id = e.attrs["data-u-id"];
      if (id === undefined || isExternal(s, e.index)) continue;
      const key = `${scope[e.index]}\u0000${id}`;
      const first = seen.get(key);
      if (first === undefined) { seen.set(key, e.index); continue; }
      out.push(make(rule, e.path, `data-u-id "${id}" is already used by ${s.elements[first].path}`,
        "Give every element a data-u-id that is unique in the screen (inner ids may repeat only across the written-out items of a data-u-repeat list)."));
    }
    return out;
  },
};
