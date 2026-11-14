import fs from "node:fs";
import path from "node:path";
import type { KitConfig } from "../kit.js";
import { firstFamily } from "../lint/css-values.js";
import { readKitTokens } from "./tokens.js";

/** One @font-face of the kit's fonts CSS (written by kit sync): the family, its descriptors and the file it loads. */
export interface KitFontFile { family: string; weight: string; style: string; file: string }

/** Licence files kit sync copies next to the fonts (OFL.txt, LICENSE, …). */
export const LICENCE_FILE = /^(ofl|licen[cs]e|copying|notice)([._ -].*)?$|^.+[._ -](ofl|licen[cs]e|copying|notice)([._ -].*)?$/i;

/** The kit's synced font faces, with each file path relative to the kit folder; null when kit sync has not written the fonts CSS. */
export function readKitFontFiles(kit: KitConfig): KitFontFile[] | null {
  const css = path.join(kit.dir, kit.fontsCss);
  if (!fs.existsSync(css)) return null;
  const base = path.dirname(kit.fontsCss);
  const out: KitFontFile[] = [];
  for (const m of fs.readFileSync(css, "utf8").matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const block = m[1];
    const family = /font-family\s*:\s*(["']?)([^;"']+)\1/i.exec(block)?.[2]?.trim();
    const url = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(block)?.[1];
    if (!family || !url || /^[a-z]+:/i.test(url)) continue;
    const weight = /font-weight\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() ?? "400";
    const style = /font-style\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() ?? "normal";
    out.push({ family, weight, style, file: path.posix.join(base.split(path.sep).join("/"), decodeURIComponent(url)) });
  }
  return out;
}

/** Locale → families written by kit sync (fonts.json next to the fonts CSS); null when absent. */
export function readKitLocaleFonts(kit: KitConfig): Record<string, string[]> | null {
  const file = path.join(kit.dir, kit.fontsCss.replace(/\.css$/i, ".json"));
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string[]>) : null;
}

/**
 * Every `--font-*` token of tokens.css whose first family the fonts CSS does not declare (compared ignoring letter case,
 * as lint does): designs that use such a token fail lint (U-CSS-010). Kit sync writes the font tokens from the Unity
 * project's fonts; the kit build reports what is left.
 */
export function fontTokenErrors(kit: KitConfig): string[] {
  const tokens = readKitTokens(kit).filter((t) => t.family === "font");
  if (tokens.length === 0) return [];
  const faces = readKitFontFiles(kit);
  const declared = [...new Set((faces ?? []).map((f) => f.family))];
  const known = new Set(declared.map((f) => f.toLowerCase()));
  const fix = "Run kit sync in the Unity project (it writes the font tokens from the project's fonts), or set the token to a declared family.";
  return tokens.flatMap((t) => {
    const family = firstFamily(t.value);
    if (faces === null) return [`tokens.css --${t.name} names the font family "${family}", but the kit has no ${kit.fontsCss}: run kit sync in the Unity project first.`];
    if (known.has(family.toLowerCase())) return [];
    return [`tokens.css --${t.name} names the font family "${family}", which ${kit.fontsCss} does not declare ` +
      `(it declares ${declared.map((f) => `"${f}"`).join(", ") || "no family"}): designs that use the token fail lint (U-CSS-010). ${fix}`];
  });
}
