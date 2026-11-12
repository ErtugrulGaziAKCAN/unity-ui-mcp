import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { KitConfig } from "../kit.js";
import { DESIGN_ORIGIN, KIT_PREFIX, type DeclaredFontFace } from "../load.js";
import { families as stackFamilies } from "./css-values.js";

/** A kit @font-face (fonts.css): its weight range and the file it loads. */
export interface KitFontFace { family: string; weightMin: number; weightMax: number; style: string; file: string | null }

export interface KitFonts {
  /** lowercased family → family as declared */
  families: Map<string, string>;
  faces: Map<string, KitFontFace[]>;
  referenceLocale: string;
  /** Families of the reference locale (lowercased): its pixels are compared, so a missing weight is an error. */
  referenceFamilies: Set<string>;
  /** Other active locales and their families (lowercased), from fonts.json next to fonts.css. */
  otherLocales: { locale: string; families: string[] }[];
  /** PostScript names of every kit font file; null when one of them could not be read. */
  postScriptNames: Set<string> | null;
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

function kitFile(kit: KitConfig, src: string | null): string | null {
  const m = src ? /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(src) : null;
  if (!m) return null;
  let u: URL;
  try { u = new URL(m[1], DESIGN_ORIGIN + KIT_PREFIX + kit.fontsCss); } catch { return null; }
  if (u.origin !== DESIGN_ORIGIN || !u.pathname.startsWith(KIT_PREFIX)) return null;
  return path.join(kit.dir, decodeURIComponent(u.pathname.slice(KIT_PREFIX.length)));
}

const psCache = new Map<string, { mtimeMs: number; name: string | null }>();

/** PostScript name (name table id 6) of a TrueType/OpenType/WOFF file; null for anything else (WOFF2, collections). */
export function readPostScriptName(file: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = psCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.name;
  let name: string | null = null;
  try { name = psNameOf(fs.readFileSync(file)); } catch { name = null; }
  psCache.set(file, { mtimeMs: st.mtimeMs, name });
  return name;
}

function psNameOf(buf: Buffer): string | null {
  const sig = buf.readUInt32BE(0);
  let table: Buffer | null = null;
  if (sig === 0x00010000 || sig === 0x4f54544f || sig === 0x74727565) { // TrueType, 'OTTO', 'true'
    const n = buf.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      if (buf.toString("latin1", r, r + 4) === "name") { const off = buf.readUInt32BE(r + 8), len = buf.readUInt32BE(r + 12); table = buf.subarray(off, off + len); }
    }
  } else if (sig === 0x774f4646) { // 'wOFF'
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const r = 44 + i * 20;
      if (buf.toString("latin1", r, r + 4) !== "name") continue;
      const off = buf.readUInt32BE(r + 4), comp = buf.readUInt32BE(r + 8), orig = buf.readUInt32BE(r + 12);
      const raw = buf.subarray(off, off + comp);
      table = comp < orig ? zlib.inflateSync(raw) : raw;
    }
  }
  if (!table) return null;
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
  let names: Set<string> | null = new Set<string>();
  for (const f of declared) {
    if (!f.fromKit) continue;
    const key = f.family.toLowerCase();
    familiesMap.set(key, f.family);
    const [weightMin, weightMax] = weightRange(f.weight || "normal");
    const file = kitFile(kit, f.src);
    faces.set(key, [...(faces.get(key) ?? []), { family: f.family, weightMin, weightMax, style: f.style || "normal", file }]);
    const ps = file ? readPostScriptName(file) : null;
    if (ps === null) names = null;
    else names?.add(ps);
  }
  const referenceLocale = kit.referenceLocale ?? kit.locales[0] ?? "";
  const map = readLocaleFonts(kit);
  const lower = (a: string[]) => a.map((x) => stackFamilies(x)[0]?.toLowerCase() ?? x.toLowerCase());
  const referenceFamilies = new Set(map && map[referenceLocale] ? lower(map[referenceLocale]) : familiesMap.keys());
  const otherLocales = map
    ? Object.entries(map).filter(([l]) => l !== referenceLocale && (kit.locales.length === 0 || kit.locales.includes(l))).map(([locale, f]) => ({ locale, families: lower(f) }))
    : [];
  return { families: familiesMap, faces, referenceLocale, referenceFamilies, otherLocales, postScriptNames: names };
}
