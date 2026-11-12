import { splitTopLevel } from "../css-values.js";
import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/** Media features of a media query list ("(min-width: 1px) and (hover: hover)" → min-width, hover). */
export function mediaFeatures(condition: string): string[] {
  const out: string[] = [];
  for (const q of splitTopLevel(condition, ",")) {
    for (const m of q.matchAll(/\(\s*([a-z-]+)\s*(?::|<|>|=|\))/gi)) out.push(m[1].toLowerCase());
    // range syntax with the value first: (1000px <= width)
    for (const m of q.matchAll(/(?:<|>|=)\s*([a-z-]+)\s*\)/gi)) out.push(m[1].toLowerCase());
  }
  return out;
}

export const rule: Rule = {
  id: "U-CSS-012", severity: "error",
  check(s) {
    return s.media.flatMap((m) => {
      const bad = Array.from(new Set(mediaFeatures(m.condition).filter((f) => !cssSupport.isMediaFeature(f))));
      return bad.length ? [make(rule, m.path, `@media ${m.condition}: feature ${bad.join(", ")}${m.source !== "rule" ? ` (${m.source} media)` : ""}`,
        `Use only ${cssSupport.mediaFeatures.join(", ")} in @media (they compile to breakpoint classes); write range syntax as min-/max-width.`)] : [];
    });
  },
};
