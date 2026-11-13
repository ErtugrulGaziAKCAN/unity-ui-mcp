import { cssSupport } from "../allowed-css.js";
import { STRUCTURAL_PSEUDO_CLASSES, type ParsedSelector } from "../selectors.js";
import type { Rule } from "../types.js";
import { stateAncestor } from "../ancestors.js";
import { at, Collector, targetOf, sources } from "./util.js";

/** Pseudo-classes USS has, plus `is-*` state classes; structural pseudo-classes are U-CSS-003's. */
function problems(sel: ParsedSelector): string[] {
  const out: string[] = [];
  for (const c of sel.compounds) {
    if (c.combinator === "+" || c.combinator === "~") out.push(`the "${c.combinator}" sibling combinator`);
    for (const x of c.simples) {
      if (x.kind === "attr") continue;
      if (x.kind === "pseudo-class" && !cssSupport.isAllowedPseudoClass(x.name) && !STRUCTURAL_PSEUDO_CLASSES.has(x.name)) out.push(`:${x.name}${x.arg !== undefined ? "()" : ""}`);
    }
  }
  return Array.from(new Set(out));
}

export const rule: Rule = {
  id: "U-CSS-027", severity: "error",
  check(s) {
    const c = new Collector();
    for (const src of sources(s)) {
      if (!src.rule) continue;
      const t = targetOf(s, src);
      if (!t) continue;
      const bad = src.rule.selectors.flatMap((sel) => problems(sel.parsed).map((p) => `${p} in "${sel.text}"`));
      // a state on an ancestor compiles as a layer naming that ancestor: exactly one, inside the screen
      for (const sel of src.rule.selectors) {
        if (sel.pseudoElement) continue;
        for (const d of sel.dynamicAncestors) for (const i of src.elements) {
          if (!(sel.elements ?? []).includes(i)) continue;
          const r = stateAncestor(s, sel, d, i);
          if ("problem" in r) bad.push(r.problem);
        }
      }
      if (bad.length) c.add(t.path, Array.from(new Set(bad)).join(", ") + at(src, t));
    }
    return c.findings(rule, `Use only :${cssSupport.pseudoClasses.filter((p) => p !== "root").join(", :")} and is-* state classes, on the element or on one ancestor inside the screen (give that ancestor a class only it has); no sibling combinators, :is(), :where(), :has(), :not(), :focus-within or :focus-visible.`);
  },
};
