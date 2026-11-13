import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { Collector, inSvg, isExternal, nonDesign, sources } from "./util.js";

const FLEX_ONLY = new Set(["align-items", "align-content", "justify-content", "flex-direction", "flex-wrap", "row-gap", "column-gap"]);
/** What to write instead of a browser default, by property group. */
function writeInstead(prop: string): string {
  if (prop.startsWith("margin-")) return "margin: 0";
  if (prop.startsWith("padding-")) return "padding: 0";
  if (prop.startsWith("border-")) return "border: 0 (or your own solid border)";
  if (prop === "appearance") return "appearance: none";
  if (prop === "text-decoration-line") return "text-decoration: none";
  if (prop === "resize") return "resize: none";
  if (prop.startsWith("white-space") || prop === "text-wrap-mode") return "white-space";
  return prop;
}

/**
 * Browser-default (user-agent) styles the compiler cannot see: it works from what the design writes, so a default
 * that renders (body, p, h1–h6 and ul margins, link colour and underline, native control look) must be written out.
 */
export const rule: Rule = {
  id: "U-CSS-026", severity: "error",
  check(s) {
    const d = cssSupport.browserDefaults;
    const inherited = new Set(d.inherited);
    const c = new Collector();
    const fixes = new Map<string, Set<string>>();
    const flag = (path: string, detail: string, prop: string) => {
      c.add(path, detail);
      fixes.set(path, (fixes.get(path) ?? new Set()).add(writeInstead(prop)));
    };
    const placeholderStyled = new Set<number>();
    for (const src of sources(s)) for (const i of src.pseudo.get("placeholder") ?? []) {
      if (src.decls.some((x) => x.name === "color")) placeholderStyled.add(i);
    }
    for (const e of s.elements) {
      if (e.ns !== "html" || inSvg(s)[e.index] || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      if (!cssSupport.isAllowedElement(e.tag, e.attrs)) continue; // U-CSS-029
      const keep = new Set(d.reproduced[e.tag] ?? []);
      for (const [prop, { value, parent }] of Object.entries(e.ua)) {
        if (keep.has(prop)) continue;
        if (inherited.has(prop)) { if (value === parent) continue; }
        else {
          const side = /^border-(top|right|bottom|left)-(style|color)$/.exec(prop);
          if (side && e.computed[`border-${side[1]}-width`] === "0px") continue;
          if (side && side[2] === "color") continue; // reported through the side's style and width
          if (FLEX_ONLY.has(prop) && !/flex|grid/.test(e.computed.display)) continue;
          if ((d.initial[prop] ?? []).includes(value)) continue;
        }
        flag(e.path, `${prop}: ${value} (browser default for <${e.tag}>)`, prop);
      }
      const ph = e.pseudo.placeholder;
      if (ph && !placeholderStyled.has(e.index) && ph.color !== e.computed.color) {
        flag(e.path, `::placeholder color: ${ph.color} (browser default)`, "::placeholder { color }");
      }
    }
    return c.findings(rule, (path) =>
      `Write these explicitly instead of relying on the browser's default style (the kit's base stylesheet resets them): ${Array.from(fixes.get(path) ?? []).join("; ")}.`);
  },
};
