import { cssSupport, type PropertySupport } from "../allowed-css.js";
import { CSS_WIDE, splitTopLevel, stripStringsAndUrls } from "../css-values.js";
import type { Rule } from "../types.js";
import { at, Collector, declsAt, declText, inSvg, judgeAt, resolved, sources, targetOf, type Target } from "./util.js";

const UNIT = /(^|[^\w.#-])[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([a-z]+)(?![\w(-])/gi;
const VIEWPORT = /^[sld]?v(?:w|h|i|b|min|max)$/; // U-CSS-006
const IDENT = /^-?[a-z_][a-z0-9_-]*$/i;

/** Keywords of a value the property does not accept (functions are U-CSS-024's; owned values are their rule's). */
function badKeywords(p: PropertySupport, value: string): string[] {
  const allowed = new Set([...(p.keywords ?? []), ...Object.keys(p.mapValues ?? {}), ...(p.owns ?? [])].map((k) => k.toLowerCase()));
  const types = p.types ?? [];
  const out: string[] = [];
  for (const item of p.list ? splitTopLevel(value, ",") : [value]) {
    for (const tok of splitTopLevel(item, " ")) {
      if (tok.includes("(") || tok === "/") continue;
      const low = tok.toLowerCase();
      if (IDENT.test(tok)) {
        if (CSS_WIDE.has(low) || allowed.has(low)) continue;
        if (types.includes("ident") || types.includes("string")) continue;
        if (types.includes("color") && cssSupport.isAllowedColorKeyword(low)) continue;
        if (!p.keywords && !types.includes("color")) continue;
        out.push(tok);
      } else if (!types.length && p.keywords && !allowed.has(low)) out.push(tok);
    }
  }
  return out;
}

/** Catch-all whitelist: properties, keywords and units the pipeline supports (allowed-css.ts, published in RULES.md). */
export const rule: Rule = {
  id: "U-CSS-023", severity: "error",
  check(s) {
    const c = new Collector();
    for (const src of sources(s)) {
      const t0 = targetOf(s, src);
      if (!t0) continue;
      const svgOnly = src.elements.length > 0 && src.elements.every((i) => inSvg(s)[i]);
      for (const i of judgeAt(s, src, t0)) {
        const t: Target = i === null ? t0 : { path: s.elements[i].path, element: s.elements[i], more: t0.more };
        const hits: string[] = [];
        for (const sel of src.rule?.selectors ?? []) {
          if (sel.pseudoElement && !cssSupport.isAllowedPseudoElement(sel.pseudoElement)) hits.push(`::${sel.pseudoElement} (in "${sel.text}") has no UI Toolkit equivalent`);
        }
        for (const d of declsAt(src, i)) {
          if (d.name.startsWith("--")) continue;
          const v = resolved(s, d.value, i);
          if (d.invalid) { hits.push(`${d.name}: ${v} does not parse after var() substitution`); continue; }
          // initial values (what shorthands write) and CSS-wide keywords add nothing an ancestor's declaration does not
          if (cssSupport.isInitialValue(d.name, v) || CSS_WIDE.has(v.trim().toLowerCase())) continue;
          // inside an inline <svg>: presentation properties are baked into the vector asset
          if (svgOnly && cssSupport.isSvgPresentation(d.name)) continue;
          const p = cssSupport.property(d.name);
          if (!p || (p.handling === "error" && !p.rule)) { hits.push(`${declText(d, v)} is not supported`); continue; }
          if (p.rule && !p.keywords) continue; // the dedicated rule judges the value
          let kws = badKeywords(p, v);
          // `border: 0` writes the initial colour (currentcolor) on sides that draw nothing
          const side = /^border-(top|right|bottom|left)-color$/.exec(d.name);
          if (side && i !== null && s.elements[i].computed[`border-${side[1]}-width`] === "0px") kws = kws.filter((k) => k.toLowerCase() !== "currentcolor");
          if (kws.length) hits.push(`${declText(d, v)}: value ${kws.map((k) => `"${k}"`).join(", ")} is not supported${p.keywords ? ` (use ${p.keywords.join(", ")})` : ""}`);
          if (d.name === "text-shadow" && splitTopLevel(v, ",").length > 1) hits.push(`${declText(d, v)}: UI Toolkit draws one text shadow`);
          if (d.name === "box-sizing" && v.trim() === "content-box") {
            const boxed = src.elements.find((k) => ["padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]
              .some((q) => s.elements[k].computed[q] !== "0px"));
            if (boxed !== undefined) hits.push(`box-sizing: content-box on an element with padding or border (UI Toolkit sizes the border box)`);
          }
          if (p.rule) continue;
          const units = Array.from(stripStringsAndUrls(v).matchAll(UNIT), (m) => m[2].toLowerCase())
            .filter((u) => !cssSupport.isAllowedUnit(u) && !VIEWPORT.test(u) && u !== "e");
          if (units.length) hits.push(`${declText(d, v)} uses unit ${Array.from(new Set(units)).join(", ")}`);
        }
        if (hits.length) { c.add(t.path, hits.join(", ") + at(src, t)); break; }
      }
    }
    return c.findings(rule,
      "Remove the property or value, or express it with supported CSS: the properties, keywords and units of RULES.md in the design kit (spec §5.3); lengths in px, % or rem; colours as hex, rgb()/rgba(), hsl()/hsla() or the basic named colours.");
  },
};
