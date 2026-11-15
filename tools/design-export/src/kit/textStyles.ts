import { exactViewports, type KitConfig } from "../kit.js";
import type { TextStyle } from "../lint/text-styles.js";
import { declaredViewports } from "../capture/matrix.js";
import { logicalViewport } from "../viewport.js";

/**
 * Kit text-style table: font sizes and CSS line boxes in whole multiples of 4 px, so both stay whole device pixels at
 * the declared viewport scales (1, 0.75, 0.5). UI Toolkit draws each text element ceil(lines × line height) device px
 * tall; only a whole line height stays exact when texts stack.
 *
 * Four line-height ratios cover the kit: 5:4 (subtitle 32/40, headline 48/60, display 64/80), 4:3 (body 24/32, title
 * 36/48), and for the smallest size, 20 px (no text draws below TEXT_FLOOR_PX device px at a declared viewport: at
 * least 18 px with the default viewports, and 20 is the next size that is whole device px at 0.75), the multiple of 4
 * nearest to each role's own ratio: 6:5 (label 20/24, nearest 5:4) and 7:5 (caption 20/28, nearest 4:3). The Unity font
 * twins carry the same line box (faceInfo.lineHeight = ratio × pointSize, half-leading folded into ascent and descent),
 * so a text block is lines × line height tall on both sides.
 */
export interface LineRatio { num: number; den: number }
export interface TextStyleRow { name: string; fontSize: number; lineHeight: number; ratio: number; weight: number }
export interface StyleSpec { name: string; fontSize: number; ratio: LineRatio }

export const RATIO_5_4: LineRatio = { num: 5, den: 4 };
export const RATIO_4_3: LineRatio = { num: 4, den: 3 };
export const RATIO_6_5: LineRatio = { num: 6, den: 5 };
export const RATIO_7_5: LineRatio = { num: 7, den: 5 };
const RATIOS = [RATIO_5_4, RATIO_4_3, RATIO_6_5, RATIO_7_5];

/** The kit's style roles with their font sizes and line-height ratios. */
export const KIT_STYLE_SPECS: ReadonlyArray<StyleSpec> = [
  { name: "caption", fontSize: 20, ratio: RATIO_7_5 },
  { name: "label", fontSize: 20, ratio: RATIO_6_5 },
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
    if (!RATIOS.some((r) => r.num === ratio.num && r.den === ratio.den)) throw new Error(`text style "${name}": ratio ${ratio.num}:${ratio.den} is not ${RATIOS.map((r) => `${r.num}:${r.den}`).join(", ")}`);
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

/**
 * The readable-text floor: no text draws below this many device px at any declared viewport, exact or scaled (the
 * game-industry practice of a minimum readable size, instead of looser checks for tiny text). Measured on the suite at
 * 1280×720 (docs/findings/text-ink.md section 9): 135 text elements drawn at 9 device px meet the exact-class ink limits
 * (ink colour ΔE2000 at most 4.29 against 4.5); at 8 device px they did not (5.66).
 */
export const TEXT_FLOOR_PX = 9;

/** The declared viewport (either class) with the smallest panel scale: where text draws smallest. */
export function smallestViewport(kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch">): { viewport: [number, number]; scale: number } {
  return declaredViewports({ referenceViewport: kit.reference, viewports: kit.viewports })
    .map((viewport) => ({ viewport, scale: logicalViewport(viewport, kit.reference, kit.screenMatch).scale }))
    .reduce((a, b) => (b.scale < a.scale ? b : a));
}

/**
 * The smallest design font size (CSS px at the reference, up to a hundredth) that draws at least TEXT_FLOOR_PX device px
 * at every declared viewport.
 */
export function minimumTextPx(kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch">): number {
  return Math.ceil(round6((TEXT_FLOOR_PX / smallestViewport(kit).scale) * 100)) / 100;
}

/** A drawn size for a message: device px to a hundredth. */
export const drawnPx = (v: number) => Math.round(v * 100) / 100;

/** The smallest font size at or above minimumTextPx that is whole device px at every exact viewport (the kit's grid). */
export function minimumKitTextPx(kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch">): number {
  const min = minimumTextPx(kit), scales = exactViewports(kit).map((vp) => logicalViewport(vp, kit.reference, kit.screenMatch).scale);
  for (let w = Math.ceil(min - 1e-9); w <= Math.ceil(min) + 256; w++) if (scales.every((x) => Number.isInteger(round6(w * x)))) return w;
  return Math.ceil(min);
}

/**
 * Kit text styles that draw below TEXT_FLOOR_PX device px at a declared viewport: one message per style, naming the
 * smallest viewport, the drawn size and the minimum design size; [] when every style holds.
 */
export function textFloorProblems(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch">): string[] {
  const { viewport, scale } = smallestViewport(kit);
  const min = minimumTextPx(kit);
  return styles.filter((s) => s.fontSize * scale < TEXT_FLOOR_PX - 1e-9).map((s) =>
    `${s.name}: ${s.fontSize}px draws ${drawnPx(s.fontSize * scale)} device px at ${viewport[0]}×${viewport[1]} (scale ${scale}); the minimum is ${min}px`);
}

/**
 * One warning per text-size step of the kit (kit.config.json `textSizes`, written by kit sync from the profile) that draws
 * a kit text style below TEXT_FLOOR_PX device px at the smallest declared viewport: a step the player picks may make text
 * smaller than the floor (the player's choice, so kit build warns and does not refuse); the design's own sizes are held to
 * the floor by kit build and lint U-FONT-004.
 */
export function textSizeFloorWarnings(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "screenMatch" | "textSizes">): string[] {
  const { viewport, scale } = smallestViewport(kit);
  const out: string[] = [];
  for (const step of kit.textSizes ?? []) {
    const below = styles.filter((s) => s.fontSize * step.scale * scale < TEXT_FLOOR_PX - 1e-9);
    if (!below.length) continue;
    const sizes = Array.from(new Set(below.map((s) => s.fontSize))).sort((a, b) => a - b);
    out.push(`text-size step "${step.key}" (×${step.scale}) draws ` +
      sizes.map((f) => `${below.filter((s) => s.fontSize === f).map((s) => s.name).join(", ")} (${f}px) at ${drawnPx(f * step.scale * scale)} device px`).join(", ") +
      ` at ${viewport[0]}×${viewport[1]}, below the readable-text floor of ${TEXT_FLOOR_PX} device px: a player who picks it reads smaller text ` +
      `(the player's choice; the design's own sizes are held to the floor). Keep the default steps at ×${Math.ceil((TEXT_FLOOR_PX / (Math.min(...styles.map((s) => s.fontSize)) * scale)) * 100) / 100} or more.`);
  }
  return out;
}

/** Throws with every problem of textFloorProblems (kit build and the Claude export refuse a kit with such a style). */
export function assertTextFloor(styles: readonly TextStyle[], kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch" | "textStyles">): void {
  const problems = textFloorProblems(styles, kit);
  if (problems.length) {
    throw new Error(`${kit.textStyles}: no text may draw below ${TEXT_FLOOR_PX} device px at a declared viewport (the readable-text floor): ` +
      `${problems.join("; ")}. Raise these styles to at least ${minimumTextPx(kit)}px, at a size that is whole device px at every exact ` +
      `viewport (${minimumKitTextPx(kit)}px with these viewports).`);
  }
}
