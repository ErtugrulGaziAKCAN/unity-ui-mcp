import { cssSupport, enabledFilterFunctions } from "../allowed-css.js";
import { functionCalls } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

/** filter functions: only those css-support.json enables, i.e. those the Unity mapper writes (kit.config.json mirrors the list). */
export const rule: Rule = {
  id: "U-CSS-015", severity: "error",
  check: (s) => {
    const enabled = enabledFilterFunctions();
    const allowed = new Set(enabled);
    return declRule(s, rule,
      // css-support.json's fix says which functions pass and why the others do not
      allowed.size
        ? cssSupport.fixFor("filter")
        : "Remove the filter: css-support.json enables no filter function yet (each is enabled once its fidelity fixture passes in Unity).",
      (d, v) => {
        if ((d.name !== "filter" && d.name !== "-webkit-filter") || v.trim() === "none") return null;
        const fns = functionCalls(v).map((c) => c.name);
        const bad = fns.length ? fns.filter((n) => !allowed.has(n.toLowerCase())) : [v.trim()];
        return bad.length ? `${declText(d, v)} (${bad.join(", ")})` : null;
      }, { pseudo: true });
  },
};
