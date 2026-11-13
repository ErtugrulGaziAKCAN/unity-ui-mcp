import { repeatSamples } from "../repeat.js";
import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";

/** Members every generated class inherits from object (the compiler's ViewCodeWriter.ObjectMembers). */
export const OBJECT_MEMBERS = ["Equals", "GetHashCode", "GetType", "ToString", "MemberwiseClone", "Finalize", "ReferenceEquals"];
/** Members the generated screen view declares (the compiler's ViewCodeWriter.ScreenMembers). */
export const SCREEN_MEMBERS = ["State", "SetState", "Find", "StateClasses", "ScreenRoot", "SetSelected", "SetClass", "SetEnabled"];
/** Members a generated repeat item view declares (the compiler's ViewCodeWriter.ItemMembers). */
export const ITEM_MEMBERS = ["Index", "BeginBind", "Find", "SetSelected", "SetClass", "SetEnabled"];

/**
 * Names an element's data-u-id cannot give in the screen view: an element with one of these names cannot have its own
 * property there.
 */
export const RESERVED_VIEW_MEMBERS = [...SCREEN_MEMBERS, ...OBJECT_MEMBERS];
/** The same for ids inside the items of a data-u-repeat list, which become members of the item view. */
export const RESERVED_ITEM_MEMBERS = [...ITEM_MEMBERS, ...OBJECT_MEMBERS];

/** The view member of a data-u-id, as the compiler names it (Naming.Pascal: parts split at . - _, each capitalised). */
export const viewMember = (id: string): string =>
  id.split(/[.\-_]/).filter((p) => p.length > 0).map((p) => p[0].toUpperCase() + p.slice(1)).join("");

/**
 * A data-u-id must not give a member the generated view class already has (State, SetState, Find, …, or the class's own
 * name <Screen>View). Ids inside the items of a data-u-repeat list are members of the item view and are checked against
 * the item's members (Index, BeginBind, …).
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
    const reservedInItem = new Set(RESERVED_ITEM_MEMBERS);
    const out = [];
    for (const e of s.elements) {
      const id = e.attrs["data-u-id"];
      if (id === undefined || isExternal(s, e.index)) continue;
      const member = viewMember(id);
      const names = inItem[e.index] ? RESERVED_ITEM_MEMBERS : RESERVED_VIEW_MEMBERS;
      if (!(inItem[e.index] ? reservedInItem : reserved).has(member)) continue;
      const where = inItem[e.index] ? "the generated item view of its data-u-repeat list" : "the generated view class";
      out.push(make(rule, e.path, `data-u-id "${id}" gives the view member ${member}, which ${where} already declares`,
        `Rename the data-u-id so its name differs from ${names.slice(0, 5).join(", ")}, … (e.g. "${id}-label").`));
    }
    return out;
  },
};
