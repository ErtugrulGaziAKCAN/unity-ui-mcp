import { referenceIsEnglish } from "../../kit.js";
import { checkedContract, designInventory, normalizeText, quote } from "../contract-scan.js";
import type { Finding, Rule } from "../types.js";
import { make } from "./util.js";

/**
 * A text key whose English differs from the screen contract's en: its data-en (data-en-<attr>), or with the reference
 * locale en the visible text, as U-MRK-014 reads it. With another reference locale, also the visible text (attribute
 * value) against the contract's ref when the contract gives one. Compared with whitespace collapsed.
 */
export const rule: Rule = {
  id: "U-CON-006", severity: "error",
  check(s, kit, _b, ctx) {
    const c = checkedContract(s, ctx);
    if (c === null) return [];
    const english = referenceIsEnglish(kit);
    const texts = new Map(c.items.filter((x) => x.kind === "text").map((x) => [x.name, x]));
    const out: Finding[] = [];
    for (const d of designInventory(s, kit)) {
      const x = d.kind === "text" ? texts.get(d.name) : undefined;
      if (x === undefined) continue;
      const bad: string[] = [];
      if (d.en !== undefined && x.en !== undefined && d.en !== normalizeText(x.en))
        bad.push(`its English ${quote(d.en)} is not the contract's en ${quote(x.en)}`);
      if (!english && d.ref !== undefined && x.ref !== undefined && d.ref !== normalizeText(x.ref))
        bad.push(`its visible text ${quote(d.ref)} is not the contract's ref ${quote(x.ref)}`);
      if (bad.length) out.push(make(rule, d.paths[0], `text "${d.name}": ${bad.join("; ")}`,
        "Use the game's text as the contract gives it; change the contract only when the user changed the text."));
    }
    return out;
  },
};
