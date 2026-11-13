import { cssSupport } from "../allowed-css.js";
import { STRUCTURAL_PSEUDO_CLASSES, type ParsedSelector } from "../selectors.js";
import type { Rule } from "../types.js";
import { at, Collector, isExternal, targetOf, sources } from "./util.js";

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
    const root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
    const inScreen = (a: number) => { for (let k = a; k >= 0; k = s.elements[k].parent) if (k === root) return true; return false; };
    for (const src of sources(s)) {
      if (!src.rule) continue;
      const t = targetOf(s, src);
      if (!t) continue;
      const bad = src.rule.selectors.flatMap((sel) => problems(sel.parsed).map((p) => `${p} in "${sel.text}"`));
      // a state on an ancestor compiles as a layer naming that ancestor: exactly one, inside the screen
      for (const sel of src.rule.selectors) {
        if (sel.pseudoElement) continue;
        for (const d of sel.dynamicAncestors) {
          const compound = sel.parsed.compounds[d.compound].simples.map((x) => x.raw).join("");
          for (const i of src.elements) {
            const m = d.matches[i] ?? [];
            if (m.length > 1) bad.push(`"${compound}" in "${sel.text}" matches ${m.length} ancestors of ${s.elements[i].path} (${m.map((a) => s.elements[a].path).join(", ")})`);
            else if (m.length === 1 && (!inScreen(m[0]) || isExternal(s, m[0]))) bad.push(`"${compound}" in "${sel.text}" matches ${s.elements[m[0]].path}, which is not part of the compiled screen`);
          }
        }
      }
      if (bad.length) c.add(t.path, Array.from(new Set(bad)).join(", ") + at(src, t));
    }
    return c.findings(rule, `Use only :${cssSupport.pseudoClasses.filter((p) => p !== "root").join(", :")} and is-* state classes, on the element or on one ancestor inside the screen (give that ancestor a class only it has); no sibling combinators, :is(), :where(), :has(), :not(), :focus-within or :focus-visible.`);
  },
};
