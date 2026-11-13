/**
 * Kit text-style table: whole-pixel font sizes with whole-pixel CSS line boxes.
 *
 * Two line-height ratios cover the kit: 1.25 for the small roles (caption, label, body, subtitle; sizes are multiples
 * of 4) and 1.125 for the large ones (title, headline, display; sizes are multiples of 8). Each size times its ratio is
 * a whole pixel count. The Unity font twins carry the same line box (faceInfo.lineHeight = ratio x pointSize, with the
 * half-leading folded into ascent and descent), so a text block's height is lines x line height on both sides.
 */
export interface TextStyleRow { name: string; fontSize: number; lineHeight: number; ratio: number; weight: number }
export interface StyleSpec { name: string; fontSize: number; ratio: number }

export const SMALL_RATIO = 1.25;
export const LARGE_RATIO = 1.125;

/** The kit's style roles with their font sizes and line-height ratios. */
export const KIT_STYLE_SPECS: ReadonlyArray<StyleSpec> = [
  { name: "caption", fontSize: 12, ratio: SMALL_RATIO },
  { name: "label", fontSize: 16, ratio: SMALL_RATIO },
  { name: "body", fontSize: 24, ratio: SMALL_RATIO },
  { name: "subtitle", fontSize: 28, ratio: SMALL_RATIO },
  { name: "title", fontSize: 32, ratio: LARGE_RATIO },
  { name: "headline", fontSize: 48, ratio: LARGE_RATIO },
  { name: "display", fontSize: 56, ratio: LARGE_RATIO },
];

/** Size granularity each ratio needs for a whole-pixel line box. */
const sizeStep = (ratio: number) => (ratio === LARGE_RATIO ? 8 : 4);

/** Regular (400) and `-bold` (700) rows for each spec, in the order given. */
export function buildTextStyles(specs: ReadonlyArray<StyleSpec> = KIT_STYLE_SPECS): TextStyleRow[] {
  const rows: TextStyleRow[] = [];
  for (const { name, fontSize, ratio } of specs) {
    if (ratio !== SMALL_RATIO && ratio !== LARGE_RATIO) throw new Error(`text style "${name}": ratio ${ratio} is not ${SMALL_RATIO} or ${LARGE_RATIO}`);
    const step = sizeStep(ratio);
    if (!Number.isInteger(fontSize) || fontSize % step !== 0) throw new Error(`text style "${name}": font size ${fontSize} is not a multiple of ${step} px`);
    const lineHeight = fontSize * ratio;
    rows.push({ name, fontSize, lineHeight, ratio, weight: 400 }, { name: `${name}-bold`, fontSize, lineHeight, ratio, weight: 700 });
  }
  return rows;
}

/** The text-styles.json object form (`{ name: { fontSize, lineHeight, weight } }`). */
export function textStylesJson(rows: TextStyleRow[]): Record<string, { fontSize: number; lineHeight: number; weight: number }> {
  return Object.fromEntries(rows.map((r) => [r.name, { fontSize: r.fontSize, lineHeight: r.lineHeight, weight: r.weight }]));
}
