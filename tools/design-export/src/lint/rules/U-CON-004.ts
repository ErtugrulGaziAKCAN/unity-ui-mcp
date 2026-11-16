import { checkedContract, describeItem, designInventory, itemKey, quote } from "../contract-scan.js";
import type { Finding, Rule } from "../types.js";
import { make } from "./util.js";

/** An item the screen contract lists in removed (the user dropped it from the current UI) is still in the design. */
export const rule: Rule = {
  id: "U-CON-004", severity: "error",
  check(s, kit, _b, ctx) {
    const c = checkedContract(s, ctx);
    if (c === null) return [];
    const removed = new Map(c.removed.map((r) => [itemKey(r), r]));
    const out: Finding[] = [];
    for (const d of designInventory(s, kit)) {
      const r = removed.get(itemKey(d));
      if (r) out.push(make(rule, d.paths[0], `${describeItem(d)} is in the screen contract's removed list (${quote(r.note)}) but still in the design`,
        "Remove it from the design: the user decided to drop it."));
    }
    return out;
  },
};
