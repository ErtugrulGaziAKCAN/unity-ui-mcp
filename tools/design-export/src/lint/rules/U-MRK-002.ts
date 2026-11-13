import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";

/**
 * Unique data-u-id. Ids repeat legitimately across the written-out items of a list: the data-u-repeat element and the
 * following siblings with the same tag and class are each their own id scope; other children of the container are not.
 */
export const rule: Rule = {
  id: "U-MRK-002", severity: "error",
  check(s) {
    const item = new Set<number>();
    for (const r of s.elements) {
      if (r.attrs["data-u-repeat"] === undefined || r.parent < 0) continue;
      const sibs = s.elements[r.parent].children;
      item.add(r.index);
      for (const i of sibs.slice(sibs.indexOf(r.index) + 1)) {
        const x = s.elements[i];
        if (x.tag !== r.tag || (x.attrs.class ?? "") !== (r.attrs.class ?? "") || x.attrs["data-u-repeat"] !== undefined) break;
        item.add(i);
      }
    }
    const scope = s.elements.map(() => -1);
    for (const e of s.elements) scope[e.index] = item.has(e.index) ? e.index : e.parent >= 0 ? scope[e.parent] : -1;
    const seen = new Map<string, number>();
    const out = [];
    for (const e of s.elements) {
      const id = e.attrs["data-u-id"];
      if (id === undefined || isExternal(s, e.index)) continue;
      const key = `${scope[e.index]}\u0000${id}`;
      const first = seen.get(key);
      if (first === undefined) { seen.set(key, e.index); continue; }
      const a = s.elements[first];
      // siblings with the same id share a path: name both by position
      const pos = (x: typeof e) => (x.parent >= 0 ? `${s.elements[x.parent].path} > ${x.tag.toLowerCase()}:${s.elements[x.parent].children.indexOf(x.index)}` : x.path);
      const where = a.path === e.path ? `${pos(a)} (this element is ${pos(e)})` : a.path;
      out.push(make(rule, e.path, `data-u-id "${id}" is already used by ${where}`,
        "Give every element a data-u-id that is unique in the screen (inner ids may repeat only across the written-out items of a data-u-repeat list)."));
    }
    return out;
  },
};
