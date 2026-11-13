import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { KitConfig } from "../kit.js";
import { DESIGN_ORIGIN, KIT_PREFIX, type DeclaredFontFace } from "../load.js";
import { families as stackFamilies } from "./css-values.js";

/** A kit @font-face (fonts.css): its weight range, style and the file it loads (with the file's character map). */
export interface KitFontFace {
  family: string; weightMin: number; weightMax: number; style: string; file: string | null;
  /** Code points the face's file maps to glyphs; null when the file could not be read (WOFF2, local(), missing). */
  cmap: Set<number> | null;
}

export interface KitFonts {
  /** lowercased family → family as declared */
  families: Map<string, string>;
  faces: Map<string, KitFontFace[]>;
  referenceLocale: string;
  /** Families of the reference locale (lowercased): its pixels are compared, so a missing weight is an error. */
  referenceFamilies: Set<string>;
  /** Other active locales and their families (lowercased), from fonts.json next to fonts.css. */
  otherLocales: { locale: string; families: string[] }[];
  /** PostScript names of the readable kit font files. */
  postScriptNames: Set<string>;
  /** Kit faces whose file could not be read: glyph coverage and font identity are not verified for them (W-FONT-002). */
  unreadable: { family: string; src: string | null; sheet: string | null }[];
}

const WEIGHT_KW: Record<string, number> = { normal: 400, bold: 700 };
export function weightRange(desc: string): [number, number] {
  const p = desc.trim().toLowerCase().split(/\s+/).filter(Boolean).map((t) => WEIGHT_KW[t] ?? Number(t));
  if (p.length === 0 || p.some((n) => !Number.isFinite(n))) return [400, 400];
  return [Math.min(...p), Math.max(...p)];
}

export function coversWeight(faces: KitFontFace[] | undefined, weight: number): boolean {
  return (faces ?? []).some((f) => f.weightMin <= weight && weight <= f.weightMax);
}

export function coversStyle(faces: KitFontFace[] | undefined, italic: boolean): boolean {
  return (faces ?? []).some((f) => (f.style !== "normal") === italic);
}

function kitFile(kit: KitConfig, src: string | null): string | null {
  const m = src ? /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(src) : null;
  if (!m) return null;
  let u: URL;
  try { u = new URL(m[1], DESIGN_ORIGIN + KIT_PREFIX + kit.fontsCss); } catch { return null; }
  if (u.origin !== DESIGN_ORIGIN || !u.pathname.startsWith(KIT_PREFIX)) return null;
  return path.join(kit.dir, decodeURIComponent(u.pathname.slice(KIT_PREFIX.length)));
}

interface FontFileInfo { postScriptName: string | null; cmap: Set<number> | null }
const fileCache = new Map<string, { mtimeMs: number; info: FontFileInfo }>();

/** PostScript name and character map of a TrueType/OpenType/WOFF file (cached by mtime); nulls for anything else. */
export function readFontFile(file: string): FontFileInfo {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return { postScriptName: null, cmap: null }; }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
  let info: FontFileInfo = { postScriptName: null, cmap: null };
  try {
    const tables = sfntTables(fs.readFileSync(file));
    if (tables) info = { postScriptName: tables.name ? psNameOf(tables.name) : null, cmap: tables.cmap ? cmapOf(tables.cmap) : null };
  } catch { /* unreadable */ }
  fileCache.set(file, { mtimeMs: st.mtimeMs, info });
  return info;
}

/** PostScript name (name table id 6) of a font file; null when it cannot be read. */
export const readPostScriptName = (file: string): string | null => readFontFile(file).postScriptName;

function sfntTables(buf: Buffer): Record<string, Buffer> | null {
  const sig = buf.readUInt32BE(0);
  const out: Record<string, Buffer> = {};
  if (sig === 0x00010000 || sig === 0x4f54544f || sig === 0x74727565) { // TrueType, 'OTTO', 'true'
    const n = buf.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const off = buf.readUInt32BE(r + 8), len = buf.readUInt32BE(r + 12);
      out[buf.toString("latin1", r, r + 4)] = buf.subarray(off, off + len);
    }
    return out;
  }
  if (sig === 0x774f4646) { // 'wOFF'
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const r = 44 + i * 20;
      const off = buf.readUInt32BE(r + 4), comp = buf.readUInt32BE(r + 8), orig = buf.readUInt32BE(r + 12);
      const raw = buf.subarray(off, off + comp);
      out[buf.toString("latin1", r, r + 4)] = comp < orig ? zlib.inflateSync(raw) : raw;
    }
    return out;
  }
  return null;
}

function psNameOf(table: Buffer): string | null {
  const count = table.readUInt16BE(2), strings = table.readUInt16BE(4);
  let mac: string | null = null;
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = table.readUInt16BE(r), nameId = table.readUInt16BE(r + 6), len = table.readUInt16BE(r + 8), off = table.readUInt16BE(r + 10);
    if (nameId !== 6) continue;
    const bytes = table.subarray(strings + off, strings + off + len);
    if (platform === 3 || platform === 0) {
      let s = "";
      for (let j = 0; j + 1 < bytes.length; j += 2) s += String.fromCharCode(bytes.readUInt16BE(j));
      return s;
    }
    if (platform === 1) mac = bytes.toString("latin1");
  }
  return mac;
}

/** Unicode code points of the best Unicode subtable (format 12 preferred, else format 4). */
function cmapOf(t: Buffer): Set<number> | null {
  const n = t.readUInt16BE(2);
  let f12 = -1, f4 = -1;
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8;
    const platform = t.readUInt16BE(r), encoding = t.readUInt16BE(r + 2), off = t.readUInt32BE(r + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = t.readUInt16BE(off);
    if (format === 12 && f12 < 0) f12 = off;
    if (format === 4 && f4 < 0) f4 = off;
  }
  const out = new Set<number>();
  if (f12 >= 0) {
    const groups = t.readUInt32BE(f12 + 12);
    for (let g = 0; g < groups; g++) {
      const r = f12 + 16 + g * 12;
      const start = t.readUInt32BE(r), end = t.readUInt32BE(r + 4), glyph = t.readUInt32BE(r + 8);
      for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
    }
    return out;
  }
  if (f4 >= 0) {
    const segX2 = t.readUInt16BE(f4 + 6), seg = segX2 / 2;
    const ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < seg; i++) {
      const end = t.readUInt16BE(ends + i * 2), start = t.readUInt16BE(starts + i * 2);
      const delta = t.readInt16BE(deltas + i * 2), rangeOff = t.readUInt16BE(ranges + i * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph: number;
        if (rangeOff === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = ranges + i * 2 + rangeOff + (c - start) * 2;
          glyph = t.readUInt16BE(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) out.add(c);
      }
    }
    return out;
  }
  return null;
}

/** Locale → family list written by kit sync next to the fonts CSS (fonts/fonts.css → fonts/fonts.json); null when absent. */
export function readLocaleFonts(kit: KitConfig): Record<string, string[]> | null {
  const file = path.join(kit.dir, kit.fontsCss.replace(/\.css$/i, "") + ".json");
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const [locale, fams] of Object.entries(raw)) {
    if (!Array.isArray(fams) || fams.some((f) => typeof f !== "string")) throw new Error(`${path.basename(file)}: "${locale}" must list family names`);
    out[locale] = fams as string[];
  }
  return out;
}

export function kitFonts(kit: KitConfig, declared: DeclaredFontFace[]): KitFonts {
  const familiesMap = new Map<string, string>();
  const faces = new Map<string, KitFontFace[]>();
  const names = new Set<string>();
  const unreadable: KitFonts["unreadable"] = [];
  for (const f of declared) {
    if (!f.fromKit) continue;
    const key = f.family.toLowerCase();
    familiesMap.set(key, f.family);
    const [weightMin, weightMax] = weightRange(f.weight || "normal");
    const file = kitFile(kit, f.src);
    const info = file ? readFontFile(file) : { postScriptName: null, cmap: null };
    faces.set(key, [...(faces.get(key) ?? []), { family: f.family, weightMin, weightMax, style: (f.style || "normal").toLowerCase(), file, cmap: info.cmap }]);
    if (info.postScriptName) names.add(info.postScriptName);
    if (!info.postScriptName || !info.cmap) unreadable.push({ family: f.family, src: f.src, sheet: f.sheet });
  }
  const referenceLocale = kit.referenceLocale ?? kit.locales[0] ?? "";
  const map = readLocaleFonts(kit);
  const lower = (a: string[]) => a.map((x) => stackFamilies(x)[0]?.toLowerCase() ?? x.toLowerCase());
  const referenceFamilies = new Set(map && map[referenceLocale] ? lower(map[referenceLocale]) : familiesMap.keys());
  const otherLocales = map
    ? Object.entries(map).filter(([l]) => l !== referenceLocale && (kit.locales.length === 0 || kit.locales.includes(l))).map(([locale, f]) => ({ locale, families: lower(f) }))
    : [];
  return { families: familiesMap, faces, referenceLocale, referenceFamilies, otherLocales, postScriptNames: names, unreadable };
}

/** Faces of a family that a weight and style select exactly (a real face); empty when it would be synthesized. */
export function realFaces(faces: KitFontFace[] | undefined, weight: number, italic: boolean): KitFontFace[] {
  return (faces ?? []).filter((f) => f.weightMin <= weight && weight <= f.weightMax && (f.style !== "normal") === italic);
}
