import fs from "node:fs";
import path from "node:path";
import type { KitConfig } from "../kit.js";
import { sameLength } from "./css-values.js";

/** A kit text style (design-kit/text-styles.json). Sizes are whole pixels (multiples of 4); line heights are fractional (e.g. 19.359375). */
export interface TextStyle { name: string; fontSize: number; lineHeight: number; weight: number }

/** Reads the kit's text styles at call time (never cached: the file is edited by kit sync). */
export function readTextStyles(kit: KitConfig): TextStyle[] {
  const file = path.join(kit.dir, kit.textStyles);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { fontSize?: unknown; lineHeight?: unknown; weight?: unknown }>;
  const out: TextStyle[] = [];
  for (const [name, v] of Object.entries(raw)) {
    const fontSize = Number(v?.fontSize), lineHeight = Number(v?.lineHeight), weight = v?.weight === undefined ? 400 : Number(v.weight);
    if (![fontSize, lineHeight, weight].every(Number.isFinite)) throw new Error(`${kit.textStyles}: style "${name}" needs numeric fontSize, lineHeight and weight`);
    out.push({ name, fontSize, lineHeight, weight });
  }
  return out;
}

/** The kit style a text element's computed size / line height / weight equals (numerically, Blink rounding allowed). */
export function matchTextStyle(styles: TextStyle[], fontSize: number, lineHeight: number | null, weight: number): TextStyle | null {
  if (lineHeight === null) return null;
  return styles.find((s) => sameLength(fontSize, s.fontSize) && sameLength(lineHeight, s.lineHeight) && s.weight === weight) ?? null;
}

/** For rich inline text (b, span): a kit style with this size and weight (line height comes from the paragraph). */
export function matchRichStyle(styles: TextStyle[], fontSize: number, weight: number): TextStyle | null {
  return styles.find((s) => sameLength(fontSize, s.fontSize) && s.weight === weight) ?? null;
}

/** Closest kit style, for fix hints. */
export function nearestTextStyle(styles: TextStyle[], fontSize: number, lineHeight: number | null, weight: number): TextStyle | null {
  let best: TextStyle | null = null, score = Infinity;
  for (const s of styles) {
    const d = Math.abs(s.fontSize - fontSize) + (lineHeight === null ? 0 : Math.abs(s.lineHeight - lineHeight) / 2) + (s.weight === weight ? 0 : 1000);
    if (d < score) { score = d; best = s; }
  }
  return best;
}

export const describeStyle = (s: TextStyle) => `${s.name} (${s.fontSize}px / ${s.lineHeight}px, ${s.weight})`;
