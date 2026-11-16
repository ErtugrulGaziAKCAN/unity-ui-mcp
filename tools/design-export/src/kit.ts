import fs from "node:fs";
import path from "node:path";
import { parseViewports } from "./viewport.js";

export interface KitConfig {
  dir: string;
  fontsCss: string;
  tokensCss: string;
  textStyles: string;
  allowedScriptOrigins: string[];
  reference: [number, number];
  /** Every declared viewport, both classes, in the order kit.config.json lists them. */
  viewports: [number, number][];
  /**
   * The declared viewports of class `scaled` (a subset of `viewports`): laid out and verified, exempt from the
   * whole-device-pixel rules (viewport.ts ViewportClass). Absent or empty: every viewport is exact.
   */
  scaledViewports?: [number, number][];
  screenMatch: number;
  filterFunctions: string[];
  locales: string[];
  /** Locale whose text the design shows and whose font pixels are compared; defaults to `locales[0]`. */
  referenceLocale?: string;
  /**
   * The game's text-size steps (kit sync writes the DesignUiProfile's): each multiplies every design text size at runtime.
   * Absent: none. Kit build warns about a step that draws a kit style below the readable-text floor.
   */
  textSizes?: { key: string; scale: number }[];
}

/** The locale code of English, the package's default reference locale (and the profile's default English locale). */
export const ENGLISH_LOCALE = "en";

/**
 * Whether the kit's reference locale is English: the visible text is then the English String Table entry (one table holds
 * both), so `data-en` may be left out and, when written, repeats the visible text.
 */
export const referenceIsEnglish = (kit: Pick<KitConfig, "locales" | "referenceLocale">): boolean =>
  (kit.referenceLocale ?? kit.locales[0] ?? "") === ENGLISH_LOCALE;

export function readKit(kitDir: string): KitConfig {
  const dir = path.resolve(kitDir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "kit.config.json"), "utf8"));
  for (const k of ["fontsCss", "tokensCss", "textStyles", "allowedScriptOrigins", "reference", "viewports", "screenMatch", "filterFunctions", "locales"]) {
    if (raw[k] === undefined) throw new Error(`kit.config.json is missing "${k}"`);
  }
  if (raw.textSizes !== undefined && !(Array.isArray(raw.textSizes) && raw.textSizes.every((t: unknown) => typeof t === "object" && t !== null &&
    typeof (t as { key?: unknown }).key === "string" && typeof (t as { scale?: unknown }).scale === "number" && (t as { scale: number }).scale > 0)))
    throw new Error(`kit.config.json: "textSizes" must be a list of { "key": string, "scale": number above 0 }`);
  const classed = parseViewports(raw.viewports);
  const ref = raw.reference as [number, number];
  if (classed.some((v) => v.class === "scaled" && v.size[0] === ref[0] && v.size[1] === ref[1]))
    throw new Error(`kit.config.json: the reference viewport ${ref[0]}×${ref[1]} is scale 1, an exact viewport; it cannot be "scaled"`);
  return {
    dir, ...raw,
    viewports: classed.map((v) => v.size),
    scaledViewports: classed.filter((v) => v.class === "scaled").map((v) => v.size),
  } as KitConfig;
}

/**
 * The kit's exact viewports in its order, the reference first when the kit does not list it: where every kit value is
 * whole device px (the viewports the whole-device-pixel rules judge).
 */
export function exactViewports(kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports">): [number, number][] {
  const scaled = kit.scaledViewports ?? [];
  const out: [number, number][] = [];
  const add = (v: [number, number]) => { if (!out.some((o) => o[0] === v[0] && o[1] === v[1])) out.push([v[0], v[1]]); };
  if (!kit.viewports.some((v) => v[0] === kit.reference[0] && v[1] === kit.reference[1])) add(kit.reference);
  for (const v of kit.viewports) if (!scaled.some((s) => s[0] === v[0] && s[1] === v[1])) add(v);
  return out;
}
