import { firstFamily } from "../css-values.js";
import { realFaces, type KitFontFace } from "../fonts.js";
import type { SnapElement } from "../snapshot.js";
import type { LintContext, Rule } from "../types.js";
import { isExternal, make, nonDesign, textElements } from "./util.js";

/** Code points that need no glyph: whitespace, controls, default-ignorable characters. */
const NO_GLYPH = new RegExp("[\\s\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufe00-\\ufe0f\\ufeff]|[\\u{e0000}-\\u{e0fff}]", "u");

function variants(text: string, transform: string): string[] {
  if (/uppercase/.test(transform)) return [text, text.toUpperCase(), text.toLocaleUpperCase("tr")];
  if (/lowercase/.test(transform)) return [text, text.toLowerCase(), text.toLocaleLowerCase("tr")];
  if (/capitalize/.test(transform)) return [text, text.toUpperCase(), text.toLocaleUpperCase("tr")];
  return [text];
}

/** Faces of the kit family that render this weight and style (the nearest real face when it is synthesized). */
function facesFor(faces: KitFontFace[], weight: number, italic: boolean): KitFontFace[] {
  const exact = realFaces(faces, weight, italic);
  if (exact.length) return exact;
  const upright = faces.filter((f) => (f.style !== "normal") === italic);
  return upright.length ? upright : faces;
}

function uncovered(ctx: LintContext, stack: string, weight: number, style: string, texts: string[], transform: string): string[] | null {
  const faces = ctx.fonts.faces.get(firstFamily(stack).toLowerCase());
  if (!faces) return null;
  const pick = facesFor(faces, weight, /^(italic|oblique)/.test(style));
  const maps = pick.map((f) => f.cmap).filter((m): m is Set<number> => m !== null);
  if (!maps.length) return null; // unreadable kit file: W-FONT-002
  const miss = new Set<string>();
  for (const t of texts) for (const v of variants(t, transform)) for (const ch of v) {
    if (NO_GLYPH.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    if (!maps.some((m) => m.has(cp))) miss.add(ch);
  }
  return Array.from(miss);
}

const contentText = (content: string) => Array.from(content.matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => m[1].replace(/\\(.)/g, "$1"));
const describe = (chars: string[]) => chars.slice(0, 12).map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ") + (chars.length > 12 ? ` and ${chars.length - 12} more` : "");

/**
 * Glyph coverage: every visible character (hidden states, placeholders and generated content included) must have a
 * glyph in the kit font that renders it, read from the kit file's cmap (independent of the fonts installed on the
 * host). Second signal: a text node Chromium rendered with a platform font or a non-kit file.
 */
export const rule: Rule = {
  id: "U-FONT-003", severity: "error",
  check(s, _k, _b, ctx) {
    const out = [];
    const check = (e: SnapElement): string[] => {
      const k = e.computed;
      const problems: string[] = [];
      const kitFamily = ctx.fonts.families.has(firstFamily(k["font-family"]).toLowerCase());
      if (kitFamily && e.texts.length) {
        const miss = uncovered(ctx, k["font-family"], Number(k["font-weight"]), k["font-style"], e.texts, k["text-transform"]);
        if (miss?.length) problems.push(`"${firstFamily(k["font-family"])}" has no glyph for ${describe(miss)}`);
        const bad = new Map<string, number>();
        e.textFonts.forEach((fonts) => {
          for (const f of fonts ?? []) {
            if (f.glyphCount <= 0) continue;
            // a custom font must be a kit file; while a kit file is unreadable (W-FONT-002) only platform fonts are certain
            const kitFile = f.isCustomFont && (ctx.fonts.postScriptNames.has(f.postScriptName) || ctx.fonts.unreadable.length > 0);
            if (!kitFile) bad.set(`${f.familyName} (${f.postScriptName})`, (bad.get(`${f.familyName} (${f.postScriptName})`) ?? 0) + f.glyphCount);
          }
        });
        if (bad.size) problems.push(`Chromium drew glyphs with fonts outside the kit: ${Array.from(bad, ([n, c]) => `${n} ${c}`).join(", ")}`);
      }
      const ph = e.pseudo.placeholder;
      if (ph && (e.attrs.placeholder ?? "").trim()) {
        const miss = uncovered(ctx, ph["font-family"], Number(ph["font-weight"]), ph["font-style"] ?? "normal", [e.attrs.placeholder], "none");
        if (miss?.length) problems.push(`placeholder: "${firstFamily(ph["font-family"])}" has no glyph for ${describe(miss)}`);
      }
      for (const p of ["before", "after"] as const) {
        const ps = e.pseudo[p];
        if (!ps) continue;
        const miss = uncovered(ctx, ps["font-family"], Number(ps["font-weight"]), ps["font-style"] ?? "normal", contentText(ps.content), "none");
        if (miss?.length) problems.push(`::${p}: "${firstFamily(ps["font-family"])}" has no glyph for ${describe(miss)}`);
      }
      return problems;
    };
    const seen = new Set<number>();
    for (const e of [...textElements(s), ...s.elements.filter((x) => x.pseudo.placeholder || x.pseudo.before || x.pseudo.after)]) {
      if (seen.has(e.index) || isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
      seen.add(e.index);
      const problems = check(e);
      if (problems.length) out.push(make(rule, e.path, problems.join("; "),
        "Use only characters the kit font covers, or add a font that covers them as a TMP fallback in the Unity project and re-run kit sync."));
    }
    return out;
  },
};
