import { layoutOf, ownStateDim } from "../layout.js";
import { sampleHidden } from "../repeat.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

const zero = (v: string) => /^(normal|0|0px|0%)(\s+(normal|0|0px|0%))?$/i.test(v.trim());

/**
 * gap is lowered to margins on the children after the first visible one. When no earlier sibling is always visible,
 * the first visible child depends on which siblings are hidden; a sibling that hides or shows itself by its own
 * pseudo-state or is-* class cannot be followed, because USS has no sibling combinator. Neither can one that the
 * written-out items of a repeat hide by markup in some items and show in others (its item view shows or hides it).
 */
export const rule: Rule = {
  id: "U-CSS-034", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const shown = sampleHidden(s);
    for (const e of s.elements) {
      if (!L.inScreen(e.index) || L.visibleDisplay(e.index) !== "flex") continue;
      const k = e.computed;
      const gap = !zero(k["row-gap"] ?? "normal") || !zero(k["column-gap"] ?? "normal") ||
        L.cands(e.index).some((x) => (x.prop === "row-gap" || x.prop === "column-gap") && !zero(x.entry.value));
      if (!gap) continue;
      const kids = L.children(e.index).filter((i) => L.inScreen(i) && L.position(i) !== "absolute");
      if (kids.some((i) => s.elements[i].attrs["data-u-repeat"] !== undefined)) continue; // a repeat's first item carries a class
      const hides = (i: number) => s.elements[i].computed.display === "none" || L.layerCands(i, "display").some((x) => x.entry.value.trim() === "none");
      for (let n = 1; n < kids.length; n++) {
        const before = kids.slice(0, n);
        if (before.some((i) => !hides(i))) break; // an always-visible earlier sibling: every later child keeps its gap
        for (const i of before.filter((k) => shown.has(k))) {
          c.add(s.elements[i].path, `${L.name(i)} is hidden by markup in some written-out items and shown in others before ${L.name(kids[n])} in the gap container ${L.name(e.index)}; the gap after it cannot follow the item`);
        }
        for (const i of before) for (const x of L.layerCands(i, "display")) {
          if (!x.dims.some(ownStateDim)) continue;
          c.add(s.elements[i].path, `${L.name(i)} shows or hides itself in layer ${x.key} before ${L.name(kids[n])} in the gap container ${L.name(e.index)}; the gap after it cannot follow its own state`);
        }
      }
    }
    return c.findings(rule, "Hide or show the sibling with a screen state (.state-x) or a state or is-* class of an ancestor, or keep an always-visible element first, or space the children with margins instead of gap.");
  },
};
