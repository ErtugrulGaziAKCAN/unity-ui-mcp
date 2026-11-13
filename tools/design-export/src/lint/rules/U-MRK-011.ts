import { repeatSamples } from "../repeat.js";
import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";

/**
 * Members every generated view class declares or inherits from object (the compiler's ViewCodeWriter.Reserved): an
 * element whose data-u-id gives one of these names cannot have its own property in the view.
 */
export const RESERVED_VIEW_MEMBERS = ["State", "SetState", "Find", "StateClasses", "ScreenRoot", "Equals", "GetHashCode", "GetType", "ToString",
  "MemberwiseClone", "Finalize", "ReferenceEquals"];

/** The view member of a data-u-id, as the compiler names it (Naming.Pascal: parts split at . - _, each capitalised). */
export const viewMember = (id: string): string =>
  id.split(/[.\-_]/).filter((p) => p.length > 0).map((p) => p[0].toUpperCase() + p.slice(1)).join("");

/**
 * A data-u-id must not give a member the generated view class already has (State, SetState, Find, …, or the class's own
 * name <Screen>View). Ids inside the items of a data-u-repeat list are members of the item, not of the view.
 */
export const rule: Rule = {
  id: "U-MRK-011", severity: "error",
  check(s) {
    const item = new Set<number>();
    for (const r of s.elements) {
      if (r.attrs["data-u-repeat"] === undefined || r.parent < 0) continue;
      for (const i of repeatSamples(s, r.index)) item.add(i);
    }
    const inItem = s.elements.map(() => false);
    for (const e of s.elements) inItem[e.index] = item.has(e.index) || (e.parent >= 0 && inItem[e.parent]);
    const screen = s.elements.find((e) => e.attrs["data-u-screen"] !== undefined)?.attrs["data-u-screen"];
    // the class is <Pascal(screen id)>View
    const reserved = new Set([...RESERVED_VIEW_MEMBERS, ...(screen ? [`${viewMember(screen)}View`] : [])]);
    const out = [];
    for (const e of s.elements) {
      const id = e.attrs["data-u-id"];
      if (id === undefined || inItem[e.index] || isExternal(s, e.index)) continue;
      const member = viewMember(id);
      if (!reserved.has(member)) continue;
      out.push(make(rule, e.path, `data-u-id "${id}" gives the view member ${member}, which the generated view class already declares`,
        `Rename the data-u-id so its name differs from ${[...RESERVED_VIEW_MEMBERS.slice(0, 5)].join(", ")}, … (e.g. "${id}-label").`));
    }
    return out;
  },
};
