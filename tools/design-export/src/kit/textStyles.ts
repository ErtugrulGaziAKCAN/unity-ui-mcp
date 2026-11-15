import { exactViewports, type KitConfig } from "../kit.js";
import type { TextStyle } from "../lint/text-styles.js";
import { declaredViewports } from "../capture/matrix.js";
import { logicalViewport } from "../viewport.js";

/**
 * Kit text-style table: font sizes and CSS line boxes in whole multiples of 4 px, so both stay whole device pixels at
 * the declared viewport scales (1, 0.75, 0.5). UI Toolkit draws each text element ceil(lines × line height) device px
 * tall; only a whole line height stays exact when texts stack.
 *
 * Two line-height ratios cover the kit: 5:4 (label 16/20, subtitle 32/40, headline 48/60, display 64/80) and 4:3
 * (caption 12/16, body 24/32, title 36/48). The Unity font twins carry the same line box (faceInfo.lineHeight =
 * ratio × pointSize, half-leading folded into ascent and descent), so a text block is lines × line height tall on both
 * sides.
 */
export interface LineRatio { num: number; den: number }
export interface TextStyleRow { name: string; fontSize: number; lineHeight: number; ratio: number; weight: number }
export interface StyleSpec { name: string; fontSize: number; ratio: LineRatio }

export const RATIO_5_4: LineRatio = { num: 5, den: 4 };
export const RATIO_4_3: LineRatio = { num: 4, den: 3 };
const RATIOS = [RATIO_5_4, RATIO_4_3];

/** The kit's style roles with their font sizes and line-height ratios. */
export const KIT_STYLE_SPECS: ReadonlyArray<StyleSpec> = [
  { name: "caption", fontSize: 12, ratio: RATIO_4_3 },
  { name: "label", fontSize: 16, ratio: RATIO_5_4 },
  { name: "body", fontSize: 24, ratio: RATIO_4_3 },
  { name: "subtitle", fontSize: 32, ratio: RATIO_5_4 },
  { name: "title", fontSize: 36, ratio: RATIO_4_3 },
  { name: "headline", fontSize: 48, ratio: RATIO_5_4 },
  { name: "display", fontSize: 64, ratio: RATIO_5_4 },
];

const PX_STEP = 4;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Regular (400) and `-bold` (700) rows for each spec, in the order given. */
export function buildTextStyles(specs: ReadonlyArray<StyleSpec> = KIT_STYLE_SPECS): TextStyleRow[] {
  const rows: TextStyleRow[] = [];
  for (const { name, fontSize, ratio } of specs) {
    if (!RATIOS.some((r) => r.num === ratio.num && r.den === ratio.den)) throw new Error(`text style "${name}": ratio ${ratio.num}:${ratio.den} is not 5:4 or 4:3`);
    if (!Number.isInteger(fontSize) || fontSize % PX_STEP !== 0) throw new Error(`text style "${name}": font size ${fontSize} is not a multiple of ${PX_STEP} px`);
    const lineHeight = (fontSize * ratio.num) / ratio.den;
    if (!Number.isInteger(lineHeight) || lineHeight % PX_STEP !== 0) throw new Error(`text style "${name}": line height ${round6(lineHeight)} (${fontSize} × ${ratio.num}/${ratio.den}) is not a multiple of ${PX_STEP} px`);
    const r = round6(ratio.num / ratio.den);
    rows.push({ name, fontSize, lineHeight, ratio: r, weight: 400 }, { name: `${name}-bold`, fontSize, lineHeight, ratio: r, weight: 700 });
  }
  return rows;
}

/** The text-styles.json object form (`{ name: { fontSize, lineHeight, weight } }`). */
export function textStylesJson(rows: TextStyleRow[]): Record<string, { fontSize: number; lineHeight: number; weight: number }> {
  return Object.fromEntries(rows.map((r) => [r.name, { fontSize: r.fontSize, lineHeight: r.lineHeight, weight: r.weight }]));
}

/**
 * Sizes and line heights that are not whole device pixels at an exact viewport's panel scale (Unity rounds font sizes
 * to whole device pixels and ceils text heights): one message per style, value and viewport; [] when all hold. Scaled
 * viewports are exempt (no value is whole there; the screen lays out at an exact scale and draws scaled).
 */
export function textStyleScaleProblems(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch">): string[] {
  const out: string[] = [];
  const vps = exactViewports(kit);
  for (const s of styles) {
    for (const [what, v] of [["font size", s.fontSize], ["line height", s.lineHeight]] as const) {
      for (const vp of vps) {
        const { scale } = logicalViewport(vp, kit.reference, kit.screenMatch);
        const dev = round6(v * scale);
        if (!Number.isInteger(dev)) out.push(`${s.name}: ${what} ${v} px is ${dev} device px at ${vp[0]}×${vp[1]} (scale ${scale})`);
      }
    }
  }
  return out;
}

/** Throws with every problem of textStyleScaleProblems (kit build and the Claude export refuse such a table). */
export function assertWholeDevicePixels(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch" | "textStyles">): void {
  const problems = textStyleScaleProblems(styles, kit);
  if (problems.length) throw new Error(`${kit.textStyles}: text styles must be whole device px at every exact viewport scale: ${problems.join("; ")}`);
}

/** Text under this many device px at the kit's smallest viewport is hard to read, and the renderers differ most there. */
export const MIN_READABLE_DEVICE_PX = 10;

/** The kit's text styles under MIN_READABLE_DEVICE_PX device px at its smallest declared viewport of either class (by panel scale). */
export function smallTextStyles(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch">): { viewport: [number, number]; scale: number; styles: TextStyle[] } {
  const smallest = declaredViewports({ referenceViewport: kit.reference, viewports: kit.viewports })
    .map((viewport) => ({ viewport, scale: logicalViewport(viewport, kit.reference, kit.screenMatch).scale }))
    .reduce((a, b) => (b.scale < a.scale ? b : a));
  return { ...smallest, styles: styles.filter((s) => s.fontSize * smallest.scale < MIN_READABLE_DEVICE_PX - 1e-9) };
}

/**
 * One readability warning for kit build and kit sync, naming every kit text style under MIN_READABLE_DEVICE_PX device px
 * at the smallest declared viewport, or null. It judges the kit's table once; designs are not linted for it (a kit's
 * own core styles would warn on every screen).
 */
export function readabilityWarning(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch">): string | null {
  const { viewport, scale, styles: small } = smallTextStyles(styles, kit);
  if (!small.length) return null;
  const sizes = Array.from(new Set(small.map((s) => s.fontSize))).sort((a, b) => a - b);
  const larger = styles.filter((s) => s.fontSize * scale >= MIN_READABLE_DEVICE_PX - 1e-9).sort((a, b) => a.fontSize - b.fontSize)[0];
  return `text styles under ${MIN_READABLE_DEVICE_PX} device px at ${viewport[0]}×${viewport[1]} (scale ${scale}): ` +
    sizes.map((f) => `${small.filter((s) => s.fontSize === f).map((s) => s.name).join(", ")} (${f}px: ${round6(f * scale)} device px)`).join(", ") +
    `. Such text is hard to read and the renderers differ most there (the fidelity check holds it to wider measured ink limits); ` +
    `keep it for secondary text and use ${larger ? `${larger.name} (${larger.fontSize}px) or larger` : "larger styles"} where the design allows it.`;
}
