import { splitTopLevel } from "../css-values.js";
import { cssSupport } from "../allowed-css.js";
import { breakpointsOf, MediaError } from "../resolve/media.js";
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

/** Media types and the `not` keyword of a media query list ("print", "not screen" → ["print", "not"]). */
export function mediaTypeProblems(condition: string): string[] {
  const out: string[] = [];
  for (const q of splitTopLevel(condition, ",")) {
    const head = q.split("(")[0].toLowerCase().replace(/\band\s*$/, "").trim();
    for (const w of head.split(/\s+/).filter(Boolean)) {
      if (w === "only" || w === "and") continue;
      if (w === "not") out.push("not");
      else if (!cssSupport.isMediaType(w)) out.push(`media type ${w}`);
    }
  }
  return out;
}

export const rule: Rule = {
  id: "U-CSS-012", severity: "error",
  check(s) {
    return s.media.flatMap((m) => {
      const bad = Array.from(new Set([...mediaTypeProblems(m.condition), ...mediaFeatures(m.condition).filter((f) => !cssSupport.isMediaFeature(f)).map((f) => `feature ${f}`)]));
      // the exporter turns each query into a breakpoint class: its values must parse the same way
      if (!bad.length) {
        try { breakpointsOf([m.condition]); } catch (e) { if (e instanceof MediaError) bad.push(e.message.replace(/^@media [^:]*: /, "")); else throw e; }
      }
      return bad.length ? [make(rule, m.path, `@media ${m.condition}: ${bad.join(", ")}${m.source !== "rule" ? ` (${m.source} media)` : ""}`,
        `Use only ${cssSupport.mediaFeatures.join(", ")} in @media, with no media type other than screen or all and no "not" (they compile to breakpoint classes); write range syntax as min-/max-width.`)] : [];
    });
  },
};
