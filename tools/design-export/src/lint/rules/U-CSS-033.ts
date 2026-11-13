import { layoutOf } from "../layout.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

/**
 * Pseudo-state combinations UI Toolkit cannot produce. A press sets :active on the pressed element only (its Clickable
 * stops the event), while CSS also activates every ancestor; only one element is focused at a time.
 */
export const rule: Rule = {
  id: "U-CSS-033", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const target = (i: number, d: string, state: string) => (d === state ? i : d.startsWith("anc(") && d.endsWith(`):${state}`) ? L.ancestorOf(d) : -1);
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      const active = new Set<number>();
      const twoFocus = new Set<string>();
      for (const cand of L.cands(e.index)) {
        const act = cand.dims.map((d) => target(e.index, d, "active")).filter((t) => t >= 0);
        act.forEach((t) => active.add(t));
        const foc = cand.dims.map((d) => target(e.index, d, "focus")).filter((t) => t >= 0);
        if (new Set(foc).size > 1) twoFocus.add(cand.key);
      }
      const names = (set: Iterable<number>) => Array.from(set).sort((a, b) => a - b).map((t) => (t === e.index ? "the element itself" : L.name(t))).join(" and ");
      if (active.size > 1) c.add(e.path, `styled for :active on ${names(active)}: a press activates them together in CSS, but UI Toolkit activates only the pressed element`);
      for (const key of twoFocus) c.add(e.path, `layer ${key.replace(/anc\(x(\d+)\)/g, (_m, n) => `anc(${L.name(Number(n))})`)} needs two focused elements at once; only one element has :focus`);
    }
    return c.findings(rule,
      "Style each press or focus on one element: either the element's own :active / :focus, or one ancestor's (.card:active .title), not both; use an is-* class set by code for a combined look.");
  },
};
