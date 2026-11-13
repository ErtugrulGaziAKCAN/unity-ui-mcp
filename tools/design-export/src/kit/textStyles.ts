/**
 * Kit text-style table: whole-pixel font sizes with the exact UI Toolkit line pitch.
 *
 * UI Toolkit (Unity 6000.3) rounds font sizes to whole device pixels, so a kit font size is a multiple of 4 px
 * (size x 0.75 and size x 0.5 stay whole at 1920x1080 and 1280x720 for a 2560x1440 reference). CSS `line-height` is
 * size x (ascent + descent) / unitsPerEm of the reference font, rounded to the nearest 1/64 px (Chromium's LayoutUnit),
 * so Chromium's line pitch equals UI Toolkit's unrounded pitch.
 */
export interface FontVerticalMetrics { ascent: number; descent: number; unitsPerEm: number }
export interface TextStyleRow { name: string; fontSize: number; lineHeight: number; weight: number }

/** Inter (hhea ascender 1984, descender 494, 2048 units per em). */
export const INTER_METRICS: FontVerticalMetrics = { ascent: 1984, descent: 494, unitsPerEm: 2048 };

/** The kit's style roles with their whole-pixel (multiple of 4) font sizes. */
export const KIT_STYLE_SIZES: ReadonlyArray<readonly [string, number]> = [
  ["caption", 12], ["label", 16], ["body", 24], ["subtitle", 28], ["title", 32], ["headline", 48], ["display", 56],
];

/** size x (ascent + descent) / unitsPerEm, rounded to the nearest 1/64 px (ties up). */
export function lineHeightFor(fontSize: number, m: FontVerticalMetrics): number {
  return Math.round(fontSize * (m.ascent + m.descent) / m.unitsPerEm * 64) / 64;
}

/** Regular (400) and `-bold` (700) rows for each named size, in the order given. */
export function buildTextStyles(
  m: FontVerticalMetrics, sizes: ReadonlyArray<readonly [string, number]> = KIT_STYLE_SIZES,
): TextStyleRow[] {
  const rows: TextStyleRow[] = [];
  for (const [name, fontSize] of sizes) {
    if (!Number.isInteger(fontSize) || fontSize % 4 !== 0) throw new Error(`text style "${name}": font size ${fontSize} is not a multiple of 4 px`);
    const lineHeight = lineHeightFor(fontSize, m);
    rows.push({ name, fontSize, lineHeight, weight: 400 }, { name: `${name}-bold`, fontSize, lineHeight, weight: 700 });
  }
  return rows;
}

/** The text-styles.json object form (`{ name: { fontSize, lineHeight, weight } }`). */
export function textStylesJson(rows: TextStyleRow[]): Record<string, { fontSize: number; lineHeight: number; weight: number }> {
  return Object.fromEntries(rows.map((r) => [r.name, { fontSize: r.fontSize, lineHeight: r.lineHeight, weight: r.weight }]));
}
