import { checkedContract, describeItem, designInventory, itemKey, normalizeText, quote } from "../contract-scan.js";
import type { Finding, Rule } from "../types.js";
import { make } from "./util.js";

/**
 * A bound text that shows, in any sample row, a value the screen contract's samples for that value do not list
 * (compared with whitespace collapsed). Image binds and requested values with no source yet have no samples to check.
 */
export const rule: Rule = {
  id: "U-CON-005", severity: "error",
  check(s, kit, _b, ctx) {
    const c = checkedContract(s, ctx);
    if (c === null) return [];
    const samples = new Map<string, Set<string>>();
    for (const x of c.items) {
      if (x.kind !== "value" || x.samples === undefined || x.image || (x.origin === "requested" && x.source === null)) continue;
      samples.set(itemKey(x), new Set(x.samples.map(normalizeText)));
    }
    const out: Finding[] = [];
    for (const d of designInventory(s, kit)) {
      const known = d.kind === "value" ? samples.get(itemKey(d)) : undefined;
      if (known === undefined) continue;
      const bad = Array.from(new Set(d.samples.filter((v) => !known.has(v))));
      if (bad.length === 0) continue;
      const more = bad.length > 3 ? ` and ${bad.length - 3} more` : "";
      out.push(make(rule, d.paths[0], `${describeItem(d)} shows ${bad.slice(0, 3).map(quote).join(", ")}${more}, not among the screen contract's samples`,
        "Use a real sample from the contract. If the game shows other values, add those real values to the contract's samples."));
    }
    return out;
  },
};
