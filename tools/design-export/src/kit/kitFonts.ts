import fs from "node:fs";
import path from "node:path";
import type { KitConfig } from "../kit.js";
import { families as familiesOf, firstFamily } from "../lint/css-values.js";
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
  // a kit without tokens.css has no font tokens (kit sync supports that); one that does not parse cannot be checked
  if (!fs.existsSync(path.join(kit.dir, kit.tokensCss))) return [];
  let all;
  try { all = readKitTokens(kit); } catch (e) { return [`${kit.tokensCss} cannot be read, so its font tokens were not checked: ${(e as Error).message}`]; }
  const tokens = all.filter((t) => t.family === "font");
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

/** The Design System's largest published file (claude.ai Design System type: 15 MiB per file). */
export const DS_FILE_CAP_BYTES = 15 * 1024 * 1024;

/** The faces a Claude Design System export ships, and what it leaves out and why. */
export interface DsFontSelection {
  shipped: KitFontFile[];
  /** Faces no text style or font token reaches (left out unless every face is asked for). */
  unreachable: KitFontFile[];
  /** Files over {@link DS_FILE_CAP_BYTES}, with their size: left out whatever reaches them. */
  oversize: { file: string; bytes: number; faces: KitFontFile[] }[];
}

const weightRange = (w: string): [number, number] => {
  const n = w.trim().toLowerCase().split(/\s+/).map((x) => (x === "normal" ? 400 : x === "bold" ? 700 : Number(x)));
  const lo = Number.isFinite(n[0]) ? n[0] : 400;
  return [lo, Number.isFinite(n[1]) ? n[1] : lo];
};
const isItalic = (f: KitFontFile) => /italic|oblique/i.test(f.style);

/**
 * The face of `faces` (one family) the browser draws `weight` (`italic`) with: the requested style first (the other when
 * the family has none of it), then the CSS font matching order for the weight (an exact or covering face; for 400–500 the
 * weights up to 500, then lighter, then heavier; below 400 lighter, then heavier; above 500 heavier, then lighter).
 */
function matchFace(faces: KitFontFile[], weight: number, italic: boolean): KitFontFile | null {
  const styled = faces.filter((f) => isItalic(f) === italic);
  const pool = styled.length ? styled : faces;
  if (!pool.length) return null;
  const covering = pool.find((f) => { const [lo, hi] = weightRange(f.weight); return lo <= weight && weight <= hi; });
  if (covering) return covering;
  const key = (f: KitFontFile) => {
    const [lo, hi] = weightRange(f.weight);
    const w = hi < weight ? hi : lo; // the face's nearest weight to the request
    if (weight >= 400 && weight <= 500) return w > weight && w <= 500 ? w - weight : w < weight ? 1000 + (weight - w) : 2000 + (w - weight);
    if (weight < 400) return w < weight ? weight - w : 1000 + (w - weight);
    return w > weight ? w - weight : 1000 + (weight - w);
  };
  return pool.slice().sort((a, b) => key(a) - key(b))[0];
}

/**
 * The faces a Claude Design System export ships: by default those the kit's text styles and font tokens can reach (each
 * family a `--font-*` token names, at 400 and 700 and every weight a text style names, italic only where a style names
 * `"fontStyle": "italic"`: what UI Toolkit's twins render too), or every face with `allFaces`; never a file over the
 * Design System's 15 MiB cap.
 */
export function selectDsFonts(kit: KitConfig, opts: { allFaces?: boolean } = {}): DsFontSelection {
  const faces = readKitFontFiles(kit) ?? [];
  let reach = faces;
  if (!opts.allFaces) {
    let tokens: ReturnType<typeof readKitTokens> = [];
    try { tokens = readKitTokens(kit); } catch { /* reported by kit build */ }
    const named = new Set(tokens.filter((t) => t.family === "font").flatMap((t) => familiesOf(t.value)).map((f) => f.toLowerCase()));
    const wants = new Map<string, [number, boolean]>([["400 n", [400, false]], ["700 n", [700, false]]]);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(kit.dir, kit.textStyles), "utf8")) as Record<string, { weight?: unknown; fontStyle?: unknown }>;
      for (const v of Object.values(raw)) {
        const w = typeof v?.weight === "number" ? v.weight : 400, it = String(v?.fontStyle ?? "").toLowerCase() === "italic";
        wants.set(`${w} ${it ? "i" : "n"}`, [w, it]);
      }
    } catch { /* reported by kit build */ }
    const byFamily = new Map<string, KitFontFile[]>();
    for (const f of faces) if (named.has(f.family.toLowerCase())) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
    const picked = new Set<KitFontFile>();
    for (const list of byFamily.values()) for (const [w, it] of wants.values()) { const m = matchFace(list, w, it); if (m) picked.add(m); }
    reach = faces.filter((f) => picked.has(f));
  }
  const sizes = new Map<string, number>();
  const size = (file: string) => {
    if (!sizes.has(file)) { let b = 0; try { b = fs.statSync(path.join(kit.dir, file)).size; } catch { /* a missing file is reported by the export */ } sizes.set(file, b); }
    return sizes.get(file)!;
  };
  const oversize = new Map<string, KitFontFile[]>();
  const shipped: KitFontFile[] = [];
  for (const f of reach) {
    if (size(f.file) > DS_FILE_CAP_BYTES) oversize.set(f.file, [...(oversize.get(f.file) ?? []), f]);
    else shipped.push(f);
  }
  return {
    shipped,
    unreachable: faces.filter((f) => !reach.includes(f)),
    oversize: Array.from(oversize, ([file, list]) => ({ file, bytes: size(file), faces: list })),
  };
}

const mib = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;

/** One line per face or file the export leaves out (printed by `kit claude` and listed in the README). */
export function dsFontNotes(sel: DsFontSelection): string[] {
  const out: string[] = [];
  if (sel.unreachable.length) {
    const n = sel.unreachable.length;
    out.push(`left out ${n} face${n === 1 ? "" : "s"} no text style or font token reaches (${sel.unreachable.map((f) => `${f.family} ${f.weight}${isItalic(f) ? " italic" : ""}`).join(", ")}); --all-faces ships them`);
  }
  for (const o of sel.oversize)
    out.push(`left out fonts/${path.posix.basename(o.file)} (${mib(o.bytes)}): over the Design System's 15 MiB file cap; Claude Design draws ${o.faces.map((f) => `${f.family} ${f.weight}${isItalic(f) ? " italic" : ""}`).join(", ")} with another font`);
  return out;
}
