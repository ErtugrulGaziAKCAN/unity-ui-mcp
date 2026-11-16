import { checkedContract, describeItem, designInventory, itemKey } from "../contract-scan.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/**
 * A value, action, state, list or text key the design has, in its scope, that the screen contract lacks. Items the
 * contract lists in removed are U-CON-004's.
 */
export const rule: Rule = {
  id: "U-CON-002", severity: "error",
  check(s, kit, _b, ctx) {
    const c = checkedContract(s, ctx);
    if (c === null) return [];
    const known = new Set([...c.items, ...c.removed].map(itemKey));
    return designInventory(s, kit).filter((d) => !known.has(itemKey(d))).map((d) => make(rule, d.paths[0],
      `${describeItem(d)} is not in the screen contract`,
      "Remove it from the design, or add it to the contract: with its game source, or as requested with the user's note (who asked, when, what)."));
  },
};
