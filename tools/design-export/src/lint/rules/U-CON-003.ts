import { checkedContract, describeItem, designInventory, itemKey } from "../contract-scan.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/** A screen contract item, not listed in removed, that the design does not have in its scope. */
export const rule: Rule = {
  id: "U-CON-003", severity: "error",
  check(s, kit, _b, ctx) {
    const c = checkedContract(s, ctx);
    if (c === null) return [];
    const drawn = new Set(designInventory(s, kit).map(itemKey));
    const removed = new Set(c.removed.map(itemKey));
    return c.items.filter((x) => !drawn.has(itemKey(x)) && !removed.has(itemKey(x))).map((x) => make(rule, "document",
      `${describeItem(x)} is in the screen contract but not in the design`,
      "Draw it in its scope, or record the user's decision to drop it in the contract's removed list (with the user's note)."));
  },
};
