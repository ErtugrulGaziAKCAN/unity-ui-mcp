/**
 * Fidelity comparison of Unity captures against the design's goldens (spec §11, §15): this decides "one to one".
 *
 * Per capture (static, pseudo-state and animation sample alike, with the same thresholds):
 * - every golden element: present in Unity (unless the compiler removed it as a wrapper that carries no text and
 *   paints nothing), the same visibility (hidden on both sides: nothing else is compared; hidden on one side: a
 *   visibility issue, never a box delta), border box within ±`boxPx`, text with the same line count and every line's
 *   baseline within ±`baselinePx` (both compared with a float tolerance of `GEOMETRY_EPS`, 0.001 px: Unity's float32
 *   layout; inputs and selects report no lines: not compared); every element Unity shows that
 *   the design does not have is an `extra` issue;
 * - copy-mask SSIM (ssim.ts): whole capture ≥ `ssimNonText`; per visible element ≥ 16×16 px ≥ `ssimElement` over its
 *   golden box joined with its active baked-shadow rect. Non-text elements use the pinned copy-mask (text element boxes
 *   copied from the design); an element that carries text uses a mask of its text lines only, so its background,
 *   border and corners count. When the plain value fails, each block may take its best value with the Unity image
 *   offset by up to 1 px, so the ±1 px box allowance (a move or a 1-px size change) cannot fail the element. An element
 *   whose box, baseline, colour, ring, ink and shadow checks all pass may instead meet a measured lower limit: a raster
 *   picture drawn scaled `ssimPicture` (UI Toolkit filters it in linear light, Chromium in sRGB), and an element whose SSIM
 *   region is smaller than an area of `ssimElementSmall` that pair's limit (SSIM over a few 8-px blocks is dominated by
 *   anti-aliased edges); both measured on identical geometry (docs/findings/ssim-small-elements.md), never below 0.97 (a
 *   raster picture resampled at a scaled viewport: `ssimResampledPicture`, ruling R125). An edge-band limit (the anti-aliasing
 *   of round shapes, moved edges, straight edges between device pixels, vector edges, and the corner samples next to them)
 *   needs its band's evidence too: outside the band every SSIM block and every 3×3 window match, and every border it masks
 *   has the design's width and, unless an animation sample moves it, its centre colour (evidenceOf; rulings R129, R130,
 *   R132: an animation counts as moving its element only when it changes geometry);
 * - colour (samples.ts): elements that paint a background get a 5×3 grid of 3×3 means inside both boxes (inset 6 px;
 *   one centre sample under 16 px), skipping points under later elements that paint or on text lines; when every
 *   grid point is covered, samples just inside the border take over; an element left without any sample is listed
 *   as "not sampled", never skipped silently. A painted line thinner than 8 device px (a divider, a bar) is sampled one
 *   pixel at a time on the centre line each renderer paints instead; Unity must draw it (a line it rounds to 0 px is a
 *   box issue) and a line left without a sample that later elements do not cover fails. Elements that carry text and
 *   paint also get ring samples (background inside the border, each border side at the centre of its painted band, the
 *   corner diagonals for the radius). Every sample is ΔE2000 ≤ `deltaE2000` against the closest Unity colour within 1 px;
 * - text ink per line: the ink colour (ΔE2000 ≤ `textInkDeltaE` for text of at least `textInkFullPx` device px, the
 *   measured `textInkDeltaESmall` limit below that size) and the ink amount: Unity's relative to the design's between
 *   `textInkRatio` and 1 (each ± `textInkCoverage`), and within ±`textInkMedianTolerance` of the capture's median ratio
 *   for text of the same polarity (light on dark, dark on light) when it has 3 or more such lines; this catches a wrong
 *   text colour, weight or size. The limits are the measured renderer difference with designs that render
 *   `-webkit-font-smoothing: antialiased` (docs/findings/text-ink.md): exact from 9 device px, wider only below; text of at most
 *   `textInkSmallPx` device px gets the suite-wide measured small-text limits (`textInkDeltaEFirstSmall`, `textInkBandSmall`, `textInkMedianToleranceSmall`),
 *   and a line whose text has a blurred text-shadow may draw up to `textInkShadowHigh` of the design's ink (its glow counts);
 * - shadow band: the mean colour of each active outer shadow's band (shadow rect minus element box), ΔE2000 ≤
 *   `deltaE2000`, so a faint missing shadow fails although SSIM dilutes it.
 * The copies of an element in a repeat's later written-out items (boxes `items`) that carry text get the same treatment as
 * the element's text (ruling R133): present and visible as in the design, the same line count, baselines and ink checks,
 * named by the copy (`row#3`), and their text masked like it; their boxes are not compared.
 * Masks are the union of both sides inflated by 2 px; Unity text is masked only for elements the design also shows. The
 * pixel row or column of a painted edge the design draws off the device grid (Chromium snaps boxes to whole CSS px, UI
 * Toolkit to whole device px) is copied from the design too, unless it would be the whole of a thin element; the box
 * check measures where that edge is. Colour samples keep their 3×3 neighbourhood off text and external regions, and only
 * the pixels they average off those edge rows (and off the area outside the screen root).
 * - text ink extent per line: where each line's first and last glyphs sit horizontally, and the width between them, each
 *   within ±`boxPx` (with `GEOMETRY_EPS`), whatever the text size: a spacing, kerning or alignment error moves glyphs inside
 *   a box of the right size, keeping its ink colour, amount, line count and baseline. Measured on both images in the same
 *   window: the column profile of Unity's ink near each end (an em) shifted to match the design's best, each scaled to the
 *   design's amount, so the renderers' stroke thickness and anti-aliasing (outer ink edges up to 2 px apart in the suite:
 *   bold 48 px strokes, a blurred text shadow) do not count; the suite's largest is 0.79 px.
 * Colours are compared premultiplied (a translucent Unity pixel counts as its colour over black). Line rects are not
 * compared (findings §4: the caret route's line rects differ from Chromium's by more than a pixel at the same break); the
 * ink extent is measured on the pixels instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rgba } from "../bake/png.js";
import type { CaptureBoxes } from "../boxes/types.js";
import { validateBoxes } from "../boxes/validate.js";
import type { CaptureApply, CaptureJob } from "../capture/matrix.js";
import { viewportClassOf, type ViewportClass } from "../viewport.js";
import { deltaE2000, hex } from "./color.js";
import { captureContext, indexIr, type CaptureContext, type IrIndex } from "./context.js";
import { decodePngAsync, encodePngAsync } from "./png.js";
import { bestDeltaE, bestDeltaEKept, borderWidths, endShift, flatAt, inkIn, nearCurve, paintedRect, ringPoints, type Ink, type RingPoint } from "./samples.js";
import { blockSsimMap, maskRects, regionSsim, regionSsimShifted, regionSsimShiftedBlocks, unionRect, wholeSsim, type Rect } from "./ssim.js";

export type { CaptureContext } from "./context.js";

export interface Thresholds {
  boxPx: number; baselinePx: number; deltaE2000: number; ssimNonText: number; ssimElement: number;
  /** Text ink colour per line (ΔE2000). */
  textInkDeltaE: number;
  /** Expected ink amount of Unity text relative to the design's (renderer difference, measured). */
  textInkRatio: number;
  /** Allowed deviation of a line's ink amount from the expected ratio (weight, size, glyph errors). */
  textInkCoverage: number;
  /** Device font size (px) from which a line's ink colour is held to `textInkDeltaE`. */
  textInkFullPx: number;
  /**
   * Ink colour limits below `textInkFullPx`: `[device px, ΔE2000]` pairs from the largest size down to 0; a line takes
   * the limit of the first pair whose size it reaches.
   */
  textInkDeltaESmall: [number, number][];
  /** Allowed deviation of a line's ink amount from the capture's median ratio of text of the same polarity. */
  textInkMedianTolerance: number;
  /**
   * Element SSIM limits for small elements: `[area in device px², limit]` pairs by growing area; an element whose SSIM
   * region is smaller than a pair's area (the first that is larger) takes its limit instead of `ssimElement`, but only when
   * every other check of the element passes. Limits between 0.97 and `ssimElement`, growing with the area.
   */
  ssimElementSmall: [number, number][];
  /** Element SSIM limit for a raster picture drawn at another size than its own (same conditions; 0.97 … ssimElement). */
  ssimPicture: number;
  /**
   * Lines after the first of text under `textInkLaterBelowPx` device px: `[device px, ΔE2000]` pairs from the largest size
   * down (the first the text reaches; a smaller text keeps its usual limit), never below the usual limit, and the ink
   * amount band `textInkCoverageLater` instead of `textInkCoverage` (measured residual, docs/findings/text-baselines.md).
   */
  textInkDeltaELater: [number, number][];
  textInkLaterBelowPx: number;
  textInkCoverageLater: number;
  /**
   * Text of at most `textInkSmallPx` device px (first lines and others): the measured scatter of the renderers at small
   * sizes, as the suite-wide maximum plus a margin (docs/findings/text-ink.md, section 7). The ink colour limit is at
   * least `textInkDeltaEFirstSmall`, the ink amount band at least `textInkBandSmall` (`[lowest, highest]` ratio of
   * Unity's ink to the design's; it covers the ink of a text shadow too). Above that size nothing changes. 0 turns it off.
   */
  textInkSmallPx: number;
  textInkDeltaEFirstSmall: number;
  textInkBandSmall: [number, number];
  /** The deviation from the capture's median ink ratio such text may have, at least `textInkMedianTolerance`. */
  textInkMedianToleranceSmall: number;
  /**
   * The highest ink ratio of a line whose text has a blurred text-shadow (the glow's pixels inside the line count as
   * ink; measured, docs/findings/text-ink.md section 8), at least 1 + `textInkCoverage`. The colour check is unchanged.
   */
  textInkShadowHigh: number;
  /**
   * Element SSIM limit of an element an animation sample shows rotated off the axes (not a multiple of 90°), when every
   * other check of the element passes: Chromium draws an element under a running transform animation from its
   * composited layer, resampled, UI Toolkit the rotated mesh with its own edge (measured, docs/findings/animation.md);
   * between 0.97 and `ssimElement`.
   */
  ssimRotated: number;
  /**
   * Element SSIM limit at a viewport whose layout scale differs from the drawn one (the scaled class: the screen lays out
   * at an exact scale and draws its root scaled, so UI Toolkit anti-aliases round shapes with a ramp of one device pixel
   * of the layout scale), only for an element whose every other check passes and whose SSIM with the edge band of round
   * shapes masked (`ROUND_EDGE_BAND` device px either side of every rounded corner's curve in the region, the outer edge
   * and the border's inner edge, on both sides) meets `ssimElement`: the difference is then confined to that band. Equal to
   * `ssimElement` (off) at exact viewports; the scaled block holds the measured value (docs/findings/viewport-classes.md).
   */
  ssimRoundEdge: number;
  /**
   * The ΔE2000 limit of a corner sample (an element that carries text and paints: the corner diagonals) whose 3×3 window
   * reaches the edge band of a round shape (`ROUND_EDGE_BAND` device px of a corner's outer curve or its border's inner
   * curve, on either side) where the scaled class's anti-aliasing ramp differs, and whose window pixels outside that band
   * meet `deltaE2000` (the difference lies in the band). Equal to `deltaE2000` (off) at exact viewports; the scaled block
   * holds the measured value.
   */
  deltaE2000RoundEdge: number;
  /**
   * The colour limit of a round element's ring when the element carries no text (a radio, an avatar ring): the middle of
   * each border side of `BORDER_SAMPLE_PX` device px or more, the ring's centre pixel, at every viewport (an element that
   * carries text samples its ring at `deltaE2000`). Measured over the suite's correct rings plus a margin; a ring of
   * another colour, also one of the same lightness that keeps the element's SSIM, fails.
   */
  deltaE2000Ring: number;
  /**
   * Element SSIM limit at a scaled viewport for an element whose difference lies in the edge band of its straight edges
   * that fall between two device pixels (the box's edges and its border's inner edges, its own and its descendants', every
   * pixel within ROUND_EDGE_BAND of such an edge in the design and in Unity) besides its round shapes': Chromium covers such a
   * pixel partly, UI Toolkit under the root scale draws the edge with its own ramp a fraction of a pixel away. Only when its
   * SSIM with that band masked meets `ssimElement` and its other checks pass. Equal to `ssimElement` (off) at exact
   * viewports; the scaled block holds the measured value.
   */
  ssimFractionalEdge: number;
  /**
   * Element SSIM limit at a scaled viewport for a vector picture (IR kind `vector`) whose difference lies in the edge band
   * of its drawn shapes (every pixel within a device pixel of a colour change in the design, markVectorEdges, leaving at
   * least half of its region compared): UI Toolkit draws the vector at the layout scale's position and ramp under the root
   * scale, Chromium at the actual scale. Only when its SSIM with that band masked meets `ssimElement` and its other checks
   * pass. Equal to `ssimElement` (off) at exact viewports; the scaled block holds the measured value.
   */
  ssimVectorEdge: number;
  /**
   * The ΔE2000 limit at a scaled viewport of a corner sample (an element that carries text and paints) whose window reaches
   * the band of its straight edges that lie between two device pixels (the box's edges and its border's inner edges, as for
   * `ssimFractionalEdge`) and whose window pixels outside that band and the round-edge band meet `deltaE2000`. Equal to
   * `deltaE2000` (off) at exact viewports; the scaled block holds the measured value.
   */
  deltaE2000FractionalEdge: number;
  /**
   * Element SSIM limit at a scaled viewport for a raster picture drawn at another size than its own (ruling R125): Chromium
   * filters it at a high quality when it downscales, UI Toolkit samples its top level bilinearly, so its block edges differ at
   * the fractional scales of that class. Only when the element's other checks pass. Equal to `ssimElement` (off) at exact
   * viewports, where the picture keeps `ssimPicture`; the scaled block holds the measured value, which may lie below the
   * absolute floor down to RESAMPLED_PICTURE_FLOOR.
   */
  ssimResampledPicture: number;
  /**
   * The colour limit of a raster picture's colour samples at a scaled viewport (ruling R125, the same resampling: a sample
   * near a block edge of the picture). Equal to `deltaE2000` (off) at exact viewports; the scaled block holds the measured value.
   */
  deltaE2000ResampledPicture: number;
  /**
   * The colour direction limit of a hairline line (ruling R138; degrees): a text line the design draws with fewer than
   * HAIRLINE_PIXELS fully covered pixels (an em dash or a "1" whose stroke lies between two device pixels), where the ink's
   * lightness and amount measure coverage, is judged by the angle between the design's and Unity's ink directions from the
   * background in sRGB (the renderers blend glyph coverage there, so a pixel's difference from the background points the same
   * way at any coverage). Measured highest over the suite's hairline lines plus a margin.
   */
  textInkDirection: number;
  /**
   * Measured limits for captures at scaled viewports (fidelity-thresholds.json `scaled`), which replace the file's own
   * values there; never the geometry limits. Absent: scaled viewports use the same thresholds.
   */
  scaled?: Partial<Omit<Thresholds, "scaled" | "boxPx" | "baselinePx">>;
}

/** `tools/design-export/fidelity-thresholds.json`, the only place the thresholds live (keys starting with `$` are comments). */
export const THRESHOLDS_FILE = fileURLToPath(new URL("../../fidelity-thresholds.json", import.meta.url));
const THRESHOLD_KEYS = ["boxPx", "baselinePx", "deltaE2000", "ssimNonText", "ssimElement", "textInkDeltaE", "textInkRatio", "textInkCoverage",
  "textInkFullPx", "textInkMedianTolerance", "ssimPicture", "textInkLaterBelowPx", "textInkCoverageLater", "textInkSmallPx", "textInkDeltaEFirstSmall", "textInkMedianToleranceSmall", "textInkShadowHigh",
  "ssimRotated", "ssimRoundEdge", "deltaE2000RoundEdge", "deltaE2000Ring", "ssimFractionalEdge", "ssimVectorEdge", "deltaE2000FractionalEdge",
  "ssimResampledPicture", "deltaE2000ResampledPicture", "textInkDirection"] as const;
/** No measured policy may accept an element SSIM below this. */
export const SSIM_FLOOR = 0.97;
/**
 * The edge band of a round shape for `ssimRoundEdge`, device px from the curve to a pixel's centre: the anti-aliasing ramp
 * of either renderer (one device pixel wide, a pixel either side of the curve).
 */
export const ROUND_EDGE_BAND = 1;
/**
 * The fewest pixels of a corner sample's window outside the edge band of round shapes (on both sides, at one offset)
 * that show its difference lies in the band (`deltaE2000RoundEdge`); a window with fewer keeps `deltaE2000`.
 */
export const ROUND_EDGE_KEPT = 3;
/**
 * The narrowest border side (device px) a round element without text has sampled as the evidence `ssimRoundEdge` needs
 * (its ring lies in the masked band): its centre pixel is covered on both renderers.
 */
export const BORDER_SAMPLE_PX = 2;
/**
 * The most a border's drawn width may differ between the design and Unity (device px, ruling R127): a text-less round
 * element's ring in every static capture, and every border an edge-band relaxation masks (ruling R129).
 */
export const RING_WIDTH_PX = 0.5;
/** The lowest `ssimResampledPicture` the scaled block may hold (ruling R125: the measured 0.95284, rounded down to 0.01). */
export const RESAMPLED_PICTURE_FLOOR = 0.95;
/** The highest small-text ink colour limit the scaled block may hold (ruling R126); text measured above it keeps failing. */
export const SCALED_SMALL_INK_CAP = 6.5;
/**
 * Hairline lines (ruling R138). A pixel of a text line is fully covered when its luma distance from the line's background is
 * at least HAIRLINE_FULL of the text colour's (the one the capture recorded for the text, over that background). A line
 * whose design shows fewer than HAIRLINE_PIXELS such pixels (the fewest the ink colour takes its median of), whose ink in the
 * design points the declared colour's way from the background (within HAIRLINE_SAME_COLOUR degrees: it is that colour at
 * partial coverage) and whose most covered pixel reaches HAIRLINE_PEAK of it (a stroke, not text under a translucent layer),
 * is a hairline line: its ink's lightness and amount measure how the stroke falls on the pixel grid, which the renderers
 * differ in. Measured over the suite (85974 lines): the 180 lines with fewer than 3 pixels at 0.85 are one-glyph texts of one
 * stroke (an em dash, a "1") at 10 and 10.67 device px, their design at most 2 such pixels; every other line at least 3.
 */
export const HAIRLINE_FULL = 0.85;
export const HAIRLINE_PIXELS = 3;
export const HAIRLINE_SAME_COLOUR = 2;
export const HAIRLINE_PEAK = 0.5;
/**
 * Ruling R141: only text of at most HAIRLINE_MAX_PX device px can be a hairline line (the suite's are 10 and 10.67), drawn at
 * full opacity in the colour the capture recorded for it (a copy's own) with no later layer over it; and its ink amount stays
 * within HAIRLINE_INK_BAND of the design's (the suite's 180 hairline lines: 0.86–1.01 by this sum, 0.69–1.17 by coverage).
 */
export const HAIRLINE_MAX_PX = 12;
export const HAIRLINE_INK_BAND: readonly [number, number] = [0.5, 2];

/** The angle in degrees between two colour directions. */
function angleBetween(p: readonly number[], q: readonly number[]): number {
  const n = Math.hypot(p[0], p[1], p[2]) * Math.hypot(q[0], q[1], q[2]);
  return n > 0 ? (Math.acos(Math.max(-1, Math.min(1, (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / n))) * 180) / Math.PI : 0;
}

/**
 * Whether the design's ink of a line is a hairline (HAIRLINE_FULL): fewer than HAIRLINE_PIXELS fully covered pixels, the
 * declared colour's direction, a most covered pixel of at least HAIRLINE_PEAK.
 */
export function isHairline(design: Ink, declared: { rgb: readonly number[]; alpha: number }): boolean {
  const lu = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const full = declared.alpha * Math.abs(lu(declared.rgb) - lu(design.bg));
  if (!(full >= 8) || !design.dists.length || design.dists[0] < HAIRLINE_PEAK * full) return false;
  let covered = 0;
  for (const d of design.dists) { if (d < HAIRLINE_FULL * full) break; if (++covered >= HAIRLINE_PIXELS) return false; }
  return angleBetween(design.dirSrgb, declared.rgb.map((c, k) => c - design.bg[k])) <= HAIRLINE_SAME_COLOUR;
}

function checkThresholds(raw: Record<string, unknown>, file: string, scaled = false): Thresholds {
  for (const k of THRESHOLD_KEYS) if (typeof raw[k] !== "number" || !Number.isFinite(raw[k])) throw new Error(`${file}: "${k}" must be a number`);
  const table = raw.textInkDeltaESmall;
  const pairs = Array.isArray(table) && table.length > 0 && table.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0));
  const ordered = pairs && (table as number[][]).every((p, i, a) => i === 0 || p[0] < a[i - 1][0]) && (table as number[][]).at(-1)![0] === 0;
  if (!ordered) throw new Error(`${file}: "textInkDeltaESmall" must be [device px, ΔE2000] pairs from the largest size down to 0`);
  const small = table as number[][];
  if (small[0][0] >= (raw.textInkFullPx as number) || small.some(([, de]) => de < (raw.textInkDeltaE as number)))
    throw new Error(`${file}: "textInkDeltaESmall" must start below textInkFullPx with limits of at least textInkDeltaE`);
  const elementSsim = raw.ssimElement as number;
  const areas = raw.ssimElementSmall;
  const areaPairs = Array.isArray(areas) && areas.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)));
  const areaOrdered = areaPairs && (areas as number[][]).every((p, i, a) => p[0] > 0 && (i === 0 || (p[0] > a[i - 1][0] && p[1] >= a[i - 1][1])));
  if (!areaOrdered) throw new Error(`${file}: "ssimElementSmall" must be [area in device px², SSIM] pairs by growing area and limit`);
  const inRange = (v: number) => v >= SSIM_FLOOR && v <= elementSsim;
  if (!(areas as number[][]).every(([, v]) => inRange(v)) || !inRange(raw.ssimPicture as number))
    throw new Error(`${file}: "ssimElementSmall" and "ssimPicture" limits must lie between ${SSIM_FLOOR} and ssimElement`);
  const later = raw.textInkDeltaELater;
  const laterOk = Array.isArray(later) && later.every((p, i, a) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    && (i === 0 || p[0] < a[i - 1][0]) && p[0] < (raw.textInkLaterBelowPx as number));
  if (!laterOk) throw new Error(`${file}: "textInkDeltaELater" must be [device px, ΔE2000] pairs from the largest size down, below textInkLaterBelowPx`);
  if ((raw.textInkCoverageLater as number) < (raw.textInkCoverage as number)) throw new Error(`${file}: "textInkCoverageLater" must be at least textInkCoverage`);
  const bandSmall = raw.textInkBandSmall;
  const bandOk = Array.isArray(bandSmall) && bandSmall.length === 2 && bandSmall.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
    && bandSmall[0] <= (raw.textInkRatio as number) * (1 - (raw.textInkCoverage as number)) && bandSmall[1] >= 1 + (raw.textInkCoverage as number);
  if (!bandOk) throw new Error(`${file}: "textInkBandSmall" must be [lowest, highest] ink ratios that contain the band of textInkRatio and textInkCoverage`);
  if ((raw.textInkMedianToleranceSmall as number) < (raw.textInkMedianTolerance as number)) throw new Error(`${file}: "textInkMedianToleranceSmall" must be at least textInkMedianTolerance`);
  if ((raw.textInkDeltaEFirstSmall as number) < (raw.textInkDeltaE as number)) throw new Error(`${file}: "textInkDeltaEFirstSmall" must be at least textInkDeltaE`);
  if ((raw.textInkShadowHigh as number) < 1 + (raw.textInkCoverage as number) - 1e-9) throw new Error(`${file}: "textInkShadowHigh" must be at least 1 + textInkCoverage`);
  if (!inRange(raw.ssimRotated as number)) throw new Error(`${file}: "ssimRotated" must lie between ${SSIM_FLOOR} and ssimElement`);
  // ssimRoundEdge applies at every viewport (its scope differs per class, compare's edgeScope); the corner limit is off at
  // exact viewports (equal to deltaE2000): only the scaled block may raise it
  const roundSsim = raw.ssimRoundEdge as number, roundDe = raw.deltaE2000RoundEdge as number;
  if (!(roundSsim >= SSIM_FLOOR && roundSsim <= 1))
    throw new Error(`${file}: "ssimRoundEdge" must lie between ${SSIM_FLOOR} and 1 (off at or above ssimElement)`);
  if (!scaled && roundDe !== (raw.deltaE2000 as number))
    throw new Error(`${file}: "deltaE2000RoundEdge" must equal deltaE2000 (off): only "scaled" may raise it`);
  if (scaled && !(roundDe >= (raw.deltaE2000 as number)))
    throw new Error(`${file}: "deltaE2000RoundEdge" must be at least deltaE2000`);
  if (!((raw.deltaE2000Ring as number) >= (raw.deltaE2000 as number))) throw new Error(`${file}: "deltaE2000Ring" must be at least deltaE2000`);
  // the scaled class's own measured limits: off at exact viewports
  for (const k of ["ssimFractionalEdge", "ssimVectorEdge"] as const) {
    const v = raw[k] as number;
    if (!scaled && !(v >= elementSsim && v <= 1)) throw new Error(`${file}: "${k}" must lie between ssimElement and 1 (off): only "scaled" may lower it`);
    if (scaled && !(v >= SSIM_FLOOR && v <= 1)) throw new Error(`${file}: "${k}" must lie between ${SSIM_FLOOR} and 1 (off at or above ssimElement)`);
  }
  const fractionalDe = raw.deltaE2000FractionalEdge as number;
  if (!scaled && fractionalDe !== (raw.deltaE2000 as number)) throw new Error(`${file}: "deltaE2000FractionalEdge" must equal deltaE2000 (off): only "scaled" may raise it`);
  if (scaled && !(fractionalDe >= (raw.deltaE2000 as number))) throw new Error(`${file}: "deltaE2000FractionalEdge" must be at least deltaE2000`);
  // ruling R125: a scaled-only key for raster pictures resampled at a fractional scale, its own floor
  const resampled = raw.ssimResampledPicture as number, resampledDe = raw.deltaE2000ResampledPicture as number;
  if (!scaled && !(resampled >= elementSsim && resampled <= 1)) throw new Error(`${file}: "ssimResampledPicture" must lie between ssimElement and 1 (off): only "scaled" may lower it`);
  if (scaled && !(resampled >= RESAMPLED_PICTURE_FLOOR && resampled <= 1)) throw new Error(`${file}: "ssimResampledPicture" must lie between ${RESAMPLED_PICTURE_FLOOR} and 1`);
  if (!scaled && resampledDe !== (raw.deltaE2000 as number)) throw new Error(`${file}: "deltaE2000ResampledPicture" must equal deltaE2000 (off): only "scaled" may raise it`);
  if (scaled && !(resampledDe >= (raw.deltaE2000 as number))) throw new Error(`${file}: "deltaE2000ResampledPicture" must be at least deltaE2000`);
  // ruling R138: a hairline line's colour direction, in degrees
  if (!((raw.textInkDirection as number) > 0 && (raw.textInkDirection as number) <= 10)) throw new Error(`${file}: "textInkDirection" must lie above 0 and at most 10 (degrees)`);
  // ruling R126: the scaled class's small-text ink colour limit has a cap
  if (scaled && (raw.textInkDeltaEFirstSmall as number) > SCALED_SMALL_INK_CAP) throw new Error(`${file}: "textInkDeltaEFirstSmall" may not exceed ${SCALED_SMALL_INK_CAP}`);
  return {
    ...(Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, raw[k] as number])) as Omit<Thresholds, "textInkDeltaESmall" | "ssimElementSmall" | "textInkDeltaELater" | "textInkBandSmall" | "scaled">),
    textInkBandSmall: [bandSmall[0], bandSmall[1]],
    textInkDeltaESmall: (table as number[][]).map(([px, de]) => [px, de] as [number, number]),
    ssimElementSmall: (areas as number[][]).map(([a, v]) => [a, v] as [number, number]),
    textInkDeltaELater: (later as number[][]).map(([px, de]) => [px, de] as [number, number]),
  };
}

/** Threshold keys a scaled-class block may not change: geometry stays ±boxPx / ±baselinePx at every viewport. */
const GEOMETRY_KEYS = new Set(["boxPx", "baselinePx"]);

/**
 * Reads the thresholds file. An optional `scaled` object holds measured limits for captures at scaled viewports
 * (viewport.ts ViewportClass): keys of the file other than the geometry limits (boxPx, baselinePx), each checked like the
 * file's own value; keys starting with `$` are comments.
 */
export function readThresholds(file: string = THRESHOLDS_FILE): Thresholds {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const base = checkThresholds(raw, file);
  if (raw.scaled === undefined) return base;
  if (!isObj(raw.scaled)) throw new Error(`${file}: "scaled" must be an object of threshold keys`);
  const own = Object.fromEntries(Object.entries(raw.scaled).filter(([k]) => !k.startsWith("$")));
  for (const k of Object.keys(own)) {
    if (GEOMETRY_KEYS.has(k)) throw new Error(`${file}: "scaled" cannot change "${k}": boxes and baselines stay within the same device px limit at every viewport`);
    if (k === "deltaE2000Ring") throw new Error(`${file}: "scaled" cannot change "deltaE2000Ring": every edge-band relaxation needs a border's colour within the file's own (ruling R130)`);
    if (!(k in base) || k === "scaled") throw new Error(`${file}: "scaled" has an unknown threshold key "${k}"`);
  }
  const merged = checkThresholds({ ...raw, ...own }, `${file} (scaled)`, true);
  const scaled = Object.fromEntries(Object.keys(own).map((k) => [k, merged[k as keyof Thresholds]])) as Thresholds["scaled"];
  return { ...base, scaled };
}

/** The thresholds a capture at a viewport of `cls` is held to: the file's, with the measured scaled-class limits at scaled viewports. */
export function thresholdsFor(t: Thresholds, cls: ViewportClass): Thresholds {
  return cls === "scaled" && t.scaled ? { ...t, ...t.scaled } : t;
}

/**
 * The measured lower element SSIM limit an element may meet when all its other checks pass: `ssimPicture` for a scaled
 * raster picture, `ssimRotated` for an element an animation sample shows rotated off the axes, else the
 * `ssimElementSmall` limit of its region's area (the lowest that applies); null when only `ssimElement` applies.
 */
export function relaxedSsimLimit(t: Thresholds, areaPx2: number, picture: boolean, rotated = false): { limit: number; why: string } | null {
  const small = t.ssimElementSmall.find(([area]) => areaPx2 < area);
  const options = [
    ...(picture ? [{ limit: t.ssimPicture, why: "a raster picture drawn scaled" }] : []),
    // off (ssimElement) outside the scaled block
    ...(picture ? [{ limit: t.ssimResampledPicture, why: "a raster picture resampled at a scaled viewport (ruling R125)" }] : []),
    ...(rotated ? [{ limit: t.ssimRotated, why: "an element an animation sample shows rotated off the axes" }] : []),
    ...(small ? [{ limit: small[1], why: `an element under ${small[0]} device px²` }] : []),
  ].filter((o) => o.limit < t.ssimElement);
  return options.length ? options.reduce((a, b) => (b.limit < a.limit ? b : a)) : null;
}

/**
 * Whether a corner ring sample's window reaches the edge band of a round shape: a pixel of it within `ROUND_EDGE_BAND`
 * device px of a corner's outer curve or of its border's inner curve, in the design's painted box or in Unity's. The
 * comparison applies `deltaE2000RoundEdge` to such a sample only when its window's pixels outside the band (on both sides)
 * meet `deltaE2000`.
 */
export function cornerInRoundBand(p: RingPoint, g: Rect, u: Rect, border: readonly number[] | undefined, radii: readonly number[] | undefined): boolean {
  if (p.kind !== "corner" || !radii) return false;
  const r = p.win >> 1;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
    if (nearCurve(g, border, radii, p.gx + dx, p.gy + dy, ROUND_EDGE_BAND) || nearCurve(u, border, radii, p.ux + dx, p.uy + dy, ROUND_EDGE_BAND)) return true;
  return false;
}

/** The ink colour limit for text of `px` device px (font size); `line` counts from 0 (later lines of small text: textInkDeltaELater). */
export function inkColourLimit(t: Thresholds, px: number, line = 0): number {
  let usual = px >= t.textInkFullPx ? t.textInkDeltaE
    : (t.textInkDeltaESmall.find(([min]) => px >= min) ?? t.textInkDeltaESmall[t.textInkDeltaESmall.length - 1])[1];
  if (px <= t.textInkSmallPx) usual = Math.max(usual, t.textInkDeltaEFirstSmall);
  if (line < 1 || px >= t.textInkLaterBelowPx) return usual;
  const later = t.textInkDeltaELater.find(([min]) => px >= min);
  return later ? Math.max(usual, later[1]) : usual;
}

export type IssueKind = "size" | "missing" | "extra" | "visibility" | "lines" | "box" | "baseline" | "inkExtent" | "ssim" | "edge" | "color" | "ink" | "inkCoverage" | "shadow";
/** Element id of capture-level issues (whole-capture SSIM, image size). */
export const WHOLE = "*";

export interface ElementIssue {
  id: string;
  kind: IssueKind;
  detail: string;
  /** Where (golden device px; Unity's for an extra element): the element box, its SSIM region or the colour sample. */
  at?: Rect;
}

/** One element of a capture: what was compared and the measured values (null: not compared). */
export interface ElementRow {
  id: string;
  status: "ok" | "fail" | "hidden" | "removed" | "missing" | "extra";
  /** Unity minus design: x, y, w, h in device px. */
  box: [number, number, number, number] | null;
  /** Element SSIM without offsets (the pinned value for non-text elements). */
  ssim: number | null;
  /** Element SSIM with each block's best offset of up to 1 px; computed only when the plain value fails. */
  ssimShifted: number | null;
  /** The measured lower limit the element met instead of ssimElement (a scaled picture or a small element), else null. */
  ssimLimit: number | null;
  /**
   * Element SSIM (best offset of up to 1 px) with the edge band of round shapes masked (`ssimRoundEdge`): computed only for
   * an element below ssimElement where `ssimRoundEdge` applies (scaled viewports); absent elsewhere.
   */
  ssimRoundEdgeMasked?: number | null;
  /**
   * Element SSIM (best offset of up to 1 px) with the straight edges between device pixels masked as well
   * (`ssimFractionalEdge`): computed only for an element below ssimElement at a scaled viewport with such edges.
   */
  ssimFractionalEdgeMasked?: number | null;
  /** Element SSIM (best offset of up to 1 px) with a vector picture's edge band masked (`ssimVectorEdge`), at a scaled viewport. */
  ssimVectorEdgeMasked?: number | null;
  /** Largest background sample ΔE2000. */
  deltaE: number | null;
  /** Background samples taken: null when the element paints no background; 0 = not sampled. */
  samples: number | null;
  /** Largest ring sample ΔE2000 (text-carrying elements: background inside the border, border, corners). */
  edge: number | null;
  /** Largest ring colour sample ΔE2000 of a round element without text (the middle of each border side; `deltaE2000Ring`). */
  ring?: number | null;
  /**
   * The largest difference (device px) between the design's and Unity's drawn width of a round element's ring without text,
   * over the middle of its sides and its corners' diagonals (`RING_WIDTH_PX`, ruling R127; static captures).
   */
  ringWidth?: number | null;
  /**
   * The evidence of the last edge-band relaxation the element was offered (rulings R129, R130): the lowest SSIM block and the
   * largest pixel ΔE2000 outside the band, the largest border centre ΔE2000 and border width difference (null: no border).
   */
  bandEvidence?: { minBlock: number; maxDe: number; ring: number | null; width: number | null };
  /** Shadow band ΔE2000. */
  band: number | null;
  /** Largest text ink colour ΔE2000 over the lines. */
  ink: number | null;
  /** Unity's text ink amount relative to the design's, for the element's worst line (0: no ink in Unity). */
  inkRatio: number | null;
  /**
   * Largest angle (degrees) between the design's and Unity's ink directions over the element's hairline lines (ruling R138:
   * lines with fewer than HAIRLINE_PIXELS fully covered pixels in the design, whose ink colour and amount are not judged);
   * absent when it has none.
   */
  inkDirection?: number | null;
  /** Largest move of a text line's ink extent over the lines (left edge, right edge or width), device px. */
  inkExtent: number | null;
  /** `<design>/<Unity>` line counts; "not compared" for text without DOM lines. */
  lines: string | null;
}

/** The capture's setup from matrix.json (null when the export has no matrix). */
export interface CaptureInfo {
  state: string;
  viewport: [number, number];
  /** The viewport's class (the IR's scaledViewports; an added coverage viewport is exact). */
  viewportClass: ViewportClass;
  apply: CaptureApply[];
  anim: { element: string; sample: number; time: number; series: string } | null;
}

export interface CaptureVerdict {
  capture: string;
  pass: boolean;
  /** Whole-capture copy-mask SSIM; null when the images could not be compared (different sizes). */
  ssim: number | null;
  issues: ElementIssue[];
  /** Golden image size. */
  size: [number, number];
  /** Lowest decisive element SSIM (the better of the plain and the offset value). */
  worstElement: { id: string; ssim: number } | null;
  maxBoxDelta: { id: string; px: number } | null;
  maxDeltaE: { id: string; deltaE: number } | null;
  /** Share of unmasked pixels with a channel off by more than 3 (null when not compared). */
  pixelsOff: number | null;
  /** Text elements whose lines are not compared (their design text is not DOM text: inputs, selects). */
  linesNotCompared: string[];
  /** Text lines an opaque later element covers entirely (an open dialog over the screen): their ink is not judged. */
  linesCovered: string[];
  /** Elements that paint a background but had no colour sample left (every point covered or on text). */
  notSampled: string[];
  /** Unity pixels with alpha below 255 (compared premultiplied). */
  translucent: number;
  /** Regions copied from the design before the pinned SSIM (text element boxes, external; inflated by 2 px). */
  masked: Rect[];
  /** Painted edge rows or columns the design draws off the device grid, copied from the design before SSIM (offGridEdges). */
  offGridEdges: number;
  /** The capture reaches past the screen root (a coverage viewport of another aspect); that area is not compared. */
  outsideScreen: boolean;
  elements: ElementRow[];
  /** Set by compareScreen. */
  info?: CaptureInfo | null;
  /** Difference image written by compareScreen (absolute path), else null. */
  diff?: string | null;
  /** Compare time of this capture in ms (compareScreen). */
  ms?: number;
}

/** The captures of one viewport class (ScreenVerdict.byClass). */
export interface ClassSummary { viewports: [number, number][]; pass: number; fail: number; notRun: number }

export interface AnimStrip {
  /** The animated element the series is named after, and every element it samples. */
  element: string;
  sampled: string[];
  viewport: [number, number];
  frames: { capture: string; time: number }[];
}

export interface ScreenVerdict {
  screen: string;
  /** Every job of the design compared and passing: status "pass". */
  pass: boolean;
  /**
   * "fail" when a capture fails or did not run (or the design has none); else "incomplete" when the design hides a job
   * in every context (no golden, nothing to compare); else "pass". An incomplete screen never passes.
   */
  status: "pass" | "fail" | "incomplete";
  captures: CaptureVerdict[];
  /** Golden captures without a Unity capture (never a pass). */
  notRun: string[];
  notRunReasons: Record<string, string>;
  /**
   * Jobs of the design's matrix whose elements no state, class context or written-out repeat item shows (matrix.json
   * `hidden`): there is no golden to compare, so they are not compared, and the screen is incomplete.
   */
  hidden: string[];
  hiddenReasons: Record<string, string>;
  /** Unity captures without a golden: reported, not failures. */
  extra: string[];
  thresholds: Thresholds;
  /** Per-step milliseconds: lint and export from the export report, steps the caller measured, compare. */
  timings: Record<string, number>;
  /** Golden platform (Chromium build, OS and CPU; findings O-14). */
  platform: { chromium: string; platform: string } | null;
  /** Compiler-removed wrappers (no boxes in Unity by design). */
  removed: string[];
  animations: AnimStrip[];
  /**
   * Per viewport class: its viewports (those with a golden capture, sorted widest first) and how many captures passed,
   * failed or did not run there. A class without captures is left out.
   */
  byClass: Partial<Record<ViewportClass, ClassSummary>>;
  /** Checks the comparison had to skip for the whole screen (e.g. no IR: no shadow bands). Shown as a warning. */
  warnings: string[];
  /** Other remarks (e.g. no capture matrix: name order, no animation strips). */
  notes: string[];
  /**
   * The colour space of the Unity project and the colour path the capture rendered with (boxes.meta.json `unity`):
   * `gamma-composite` blends as the design (in game: DesignUiGammaComposite), `linear-panel` as an ordinary on-screen
   * panel of a Linear project, `gamma-project` a Gamma project's panel (no composite). Null without the meta file.
   */
  colour: { space: string; path: string } | null;
}

export interface CompareOptions {
  /** Compiler-removed elements; default: `removedElements` of `<unityDir>/.design-ui.json` (the generated manifest), else none. */
  removed?: string[];
  /** Write a difference image into this folder (`<capture>.png`) for every capture with pixels off by more than 3. */
  diffDir?: string;
  /** Step timings measured by the caller (import, compile, capture …), merged into the verdict's timings. */
  timings?: Record<string, number>;
  /** Captures compared at the same time (default: up to 4). */
  concurrency?: number;
}

const EPS = 1e-6;

/** Whether point (x, y) is inside a box with corner radii (top-left, top-right, bottom-right, bottom-left), grown by `grow`. */
function insideRounded(b: Rect, r: readonly number[] | undefined, x: number, y: number, grow: number): boolean {
  const x0 = b.x - grow, y0 = b.y - grow, x1 = b.x + b.w + grow, y1 = b.y + b.h + grow;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (!r) return true;
  const corner = (rad: number, cx: number, cy: number) => rad <= 0 || (x - cx) ** 2 + (y - cy) ** 2 <= (rad + grow) ** 2;
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, v));
  if (x < x0 + tl && y < y0 + tl) return corner(tl, x0 + tl, y0 + tl);
  if (x > x1 - tr && y < y0 + tr) return corner(tr, x1 - tr, y0 + tr);
  if (x > x1 - br && y > y1 - br) return corner(br, x1 - br, y1 - br);
  if (x < x0 + bl && y > y1 - bl) return corner(bl, x0 + bl, y1 - bl);
  return true;
}

/** Whether every pixel of a window inside the image is hidden. */
function everyPixel(r: Rect, w: number, h: number, hidden: (x: number, y: number) => boolean): boolean {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(w, Math.ceil(r.x + r.w)), y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(h, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return false;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!hidden(x, y)) return false;
  return true;
}
/**
 * Float tolerance of the box and baseline limits (device px): Unity reports its layout in float32, so a box UI Toolkit
 * snaps by exactly the limit (a frame at a half CSS pixel at scale 0.75: 366 → 274.5 device px, drawn at 275) arrives as
 * 1.000008 px. One thousandth of a pixel absorbs that rounding (float32 resolution at 4096 px is 0.0005) and widens
 * nothing a renderer can draw.
 */
export const GEOMETRY_EPS = 1e-3;
const MIN_ELEMENT = 16;
/** Painted elements thinner than this (device px) are lines: sampled on their centre line, one pixel at a time. */
const THIN_PX = 8;
const MIN_INK_PX = 16;
const FX = [0.1, 0.3, 0.5, 0.7, 0.9], FY = [0.25, 0.5, 0.75];
const fmt = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)} %`;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lumaOf = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

type Box = CaptureBoxes["elements"][string];
type ItemCopy = NonNullable<CaptureBoxes["items"]>[string];
interface Side { png: Rgba; boxes: CaptureBoxes }

/** The image with every pixel premultiplied by its alpha (a translucent pixel as its colour over black). */
function opaque(img: Rgba): { img: Rgba; translucent: number } {
  let translucent = 0;
  for (let o = 3; o < img.data.length; o += 4) if (img.data[o] !== 255) translucent++;
  if (!translucent) return { img, translucent };
  const data = new Uint8Array(img.data.length);
  for (let o = 0; o < data.length; o += 4) {
    const a = img.data[o + 3];
    data[o] = Math.round((img.data[o] * a) / 255); data[o + 1] = Math.round((img.data[o + 1] * a) / 255); data[o + 2] = Math.round((img.data[o + 2] * a) / 255); data[o + 3] = 255;
  }
  return { img: { w: img.w, h: img.h, data }, translucent };
}

/**
 * The one-pixel rows and columns where an element's painted edge falls between device pixels in the design: Chromium
 * paints a box at its layout rect snapped to whole CSS px (paintedRect), so its edge pixel is partly covered there while
 * UI Toolkit snaps the edge to a whole device pixel. An axis whose edge pixels would be every pixel the element paints
 * across it (a line of about 2 device px or less) keeps them: the mask never hides a whole element.
 */
export function offGridEdges(boxes: readonly Box[], scale: number): Rect[] {
  const out: Rect[] = [];
  const frac = (v: number) => { const f = v - Math.floor(v); return f > 1e-3 && f < 1 - 1e-3; };
  /** The edge pixels of [a, b) to copy, or none when they are all of its pixels. */
  const edges = (a: number, b: number): number[] => {
    const px = new Set([...(frac(a) ? [Math.floor(a)] : []), ...(frac(b) ? [Math.floor(b)] : [])]);
    return px.size < Math.ceil(b - 1e-9) - Math.floor(a) ? [...px] : [];
  };
  for (const b of boxes) {
    if (!b?.visible || b.w <= 0 || b.h <= 0) continue;
    const p = paintedRect(b, scale);
    for (const x of edges(p.x, p.x + p.w)) out.push({ x, y: p.y, w: 1, h: p.h });
    for (const y of edges(p.y, p.y + p.h)) out.push({ x: p.x, y, w: p.w, h: 1 });
  }
  return out;
}

/**
 * Marks in `out` (a w × h mask) the band of a box's straight edges: its four edges and its border's inner edges, each the
 * pixels whose centre lies within ROUND_EDGE_BAND of that edge in the design's box `gb` and in Unity's `ub` (an edge on the
 * device grid on both sides marks nothing), inside the pixel range `r`. Returns whether it marked anything.
 */
function markBoxEdges(out: Uint8Array, w: number, h: number, gb: Rect, ub: Rect, border: readonly number[] | undefined,
                      r: { x0: number; x1: number; y0: number; y1: number }): boolean {
  const bw = border ?? [0, 0, 0, 0], band = ROUND_EDGE_BAND;
  const x0 = Math.max(0, r.x0), x1 = Math.min(w, r.x1), y0 = Math.max(0, r.y0), y1 = Math.min(h, r.y1);
  const line = (gv: number, uv: number, horizontal: boolean, from: number, to: number): boolean => {
    if (!offPixel(gv) && !offPixel(uv)) return false;
    let any = false;
    for (let k = Math.ceil(Math.max(gv, uv) - band - 0.5); k <= Math.floor(Math.min(gv, uv) + band - 0.5); k++) {
      if (Math.abs(k + 0.5 - gv) >= band || Math.abs(k + 0.5 - uv) >= band) continue;
      if (horizontal ? k < y0 || k >= y1 : k < x0 || k >= x1) continue;
      for (let o = Math.max(horizontal ? x0 : y0, from); o < Math.min(horizontal ? x1 : y1, to); o++) out[horizontal ? k * w + o : o * w + k] = 1;
      any = true;
    }
    return any;
  };
  const xa = Math.floor(Math.min(gb.x, ub.x)), xb = Math.ceil(Math.max(gb.x + gb.w, ub.x + ub.w));
  const ya = Math.floor(Math.min(gb.y, ub.y)), yb = Math.ceil(Math.max(gb.y + gb.h, ub.y + ub.h));
  const rows: [number, number][] = [[gb.y, ub.y], [gb.y + gb.h, ub.y + ub.h]], cols: [number, number][] = [[gb.x, ub.x], [gb.x + gb.w, ub.x + ub.w]];
  if (bw[0] > 0) rows.push([gb.y + bw[0], ub.y + bw[0]]);
  if (bw[2] > 0) rows.push([gb.y + gb.h - bw[2], ub.y + ub.h - bw[2]]);
  if (bw[3] > 0) cols.push([gb.x + bw[3], ub.x + bw[3]]);
  if (bw[1] > 0) cols.push([gb.x + gb.w - bw[1], ub.x + ub.w - bw[1]]);
  let any = false;
  for (const [gv, uv] of rows) if (line(gv, uv, true, xa, xb)) any = true;
  for (const [gv, uv] of cols) if (line(gv, uv, false, ya, yb)) any = true;
  return any;
}

/**
 * The edge band of a vector picture in the design: every pixel whose 3×3 window holds a colour change (a channel more than
 * VECTOR_EDGE_STEP apart from the centre's), so within a device pixel of one of its drawn edges. Marked in `out` inside
 * `region`; returns how many pixels of the region it left unmarked.
 */
function markVectorEdges(out: Uint8Array, img: Rgba, region: Rect): { kept: number; all: number } {
  const x0 = Math.max(0, Math.floor(region.x)), x1 = Math.min(img.w, Math.ceil(region.x + region.w));
  const y0 = Math.max(0, Math.floor(region.y)), y1 = Math.min(img.h, Math.ceil(region.y + region.h));
  const d = img.data;
  let kept = 0, all = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.w + x) * 4;
    let edge = false;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(img.h - 1, y + 1) && !edge; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(img.w - 1, x + 1); xx++) {
      const q = (yy * img.w + xx) * 4;
      if (Math.abs(d[q] - d[o]) > VECTOR_EDGE_STEP || Math.abs(d[q + 1] - d[o + 1]) > VECTOR_EDGE_STEP || Math.abs(d[q + 2] - d[o + 2]) > VECTOR_EDGE_STEP) { edge = true; break; }
    }
    all++;
    if (edge) out[y * img.w + x] = 1;
    else if (!out[y * img.w + x]) kept++;
  }
  return { kept, all };
}

/** A colour step (8-bit channel) that makes a pixel part of a vector picture's edge band (markVectorEdges). */
const VECTOR_EDGE_STEP = 6;
/** The share of a vector element's region its edge band must leave compared for ssimVectorEdge: the shape's inside and the space around it. */
const VECTOR_KEPT = 0.5;

/** A position between two device pixels (more than 0.01 px from a whole one). */
const offPixel = (v: number) => Math.abs(v - Math.round(v)) > 0.01;
/** Whether a box sits at a fractional device offset: one of its edges lies between two device pixels. */
function fractionalBox(b: Rect): boolean {
  return [b.x, b.y, b.x + b.w, b.y + b.h].some(offPixel);
}

/** Mean colour of the pixels whose centre is in `outer` but not in `inner`; null when there are none. */
function bandMean(img: Rgba, outer: Rect, inner: Rect, from?: { a: Rgba; mask: Uint8Array }): [number, number, number] | null {
  const x0 = Math.max(0, Math.ceil(outer.x - 0.5)), x1 = Math.min(img.w, Math.ceil(outer.x + outer.w - 0.5));
  const y0 = Math.max(0, Math.ceil(outer.y - 0.5)), y1 = Math.min(img.h, Math.ceil(outer.y + outer.h - 0.5));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const cy = y + 0.5, inRow = cy >= inner.y && cy < inner.y + inner.h;
    for (let x = x0; x < x1; x++) {
      const cx = x + 0.5;
      if (inRow && cx >= inner.x && cx < inner.x + inner.w) continue;
      const p = y * img.w + x, src = from && from.mask[p] ? from.a.data : img.data, o = p * 4;
      r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : null;
}

/**
 * The share of unmasked pixels whose largest channel difference exceeds 3 and, when asked and there are any, a
 * difference image: transparent where equal, yellow to red with the difference (masked pixels stay transparent; the
 * report draws the masked rects itself).
 */
function difference(a: Rgba, b: Rgba, mask: Uint8Array, wantImage: boolean): { image: Rgba | null; off: number } {
  const n = a.w * a.h, da = a.data, db = b.data;
  let off = 0, counted = 0, out: Uint8Array | null = null;
  for (let p = 0; p < n; p++) {
    if (mask[p]) continue;
    counted++;
    const o = p * 4;
    const d0 = da[o] - db[o], d1 = da[o + 1] - db[o + 1], d2 = da[o + 2] - db[o + 2];
    const d = Math.max(d0 < 0 ? -d0 : d0, d1 < 0 ? -d1 : d1, d2 < 0 ? -d2 : d2);
    if (d <= 3) continue;
    off++;
    if (!wantImage) continue;
    out ??= new Uint8Array(n * 4);
    const t = Math.min(1, (d - 3) / 60);
    out[o] = 255; out[o + 1] = Math.round(220 * (1 - t)); out[o + 2] = 0; out[o + 3] = Math.round(190 + 65 * t);
  }
  return { image: out ? { w: a.w, h: a.h, data: out } : null, off: counted ? off / counted : 0 };
}

interface Analysis { verdict: CaptureVerdict; heat: Rgba | null }

function analyze(golden: Side, unity: Side, removed: readonly string[], t: Thresholds, ctx: CaptureContext, wantHeat: boolean): Analysis {
  const g = golden.boxes, u = unity.boxes, gp = opaque(golden.png).img;
  const { img: up, translucent } = opaque(unity.png);
  const issues: ElementIssue[] = [];
  const rows: ElementRow[] = [];
  const linesNotCompared: string[] = [], notSampled: string[] = [];
  /** Text lines an opaque later element covers entirely: their ink is not judged (`<id>: line <k> of <n>`). */
  const linesCovered: string[] = [];
  const removedSet = new Set(removed);
  const issue = (id: string, kind: IssueKind, detail: string, at?: Rect) => issues.push(at ? { id, kind, detail, at } : { id, kind, detail });
  const newRow = (id: string, status: ElementRow["status"] = "ok"): ElementRow =>
    ({ id, status, box: null, ssim: null, ssimShifted: null, ssimLimit: null, deltaE: null, samples: null, edge: null, band: null, ink: null, inkRatio: null, inkExtent: null, lines: null });

  // ---- image size (HiDPI captures are an error, never rescaled)
  const sameSize = gp.w === up.w && gp.h === up.h;
  if (!sameSize) issue(WHOLE, "size", `Unity capture is ${up.w}×${up.h} px, the design ${gp.w}×${gp.h} px; images not compared`);
  if (u.viewport[0] !== g.viewport[0] || u.viewport[1] !== g.viewport[1]) {
    issue(WHOLE, "size", `Unity boxes are for viewport ${u.viewport.join("×")}, the design's for ${g.viewport.join("×")}`);
  }

  // ---- element order: paint order when the IR is known, then any other golden ids
  const order = ctx.order ?? [], inOrder = new Set(order);
  const ids = [...order.filter((id) => id in g.elements), ...Object.keys(g.elements).filter((id) => !inOrder.has(id)).sort()];
  const rowOf = new Map<string, ElementRow>();
  let maxBox: { id: string; px: number } | null = null;
  const compared: string[] = [];
  type TextBox = { lines: readonly (Rect & { baseline: number; mixed?: boolean })[] };
  /** A text's line count and baselines (an IR element's, or its copy's in a later repeat item, `key` naming it). */
  const lineCheck = (key: string, ge: TextBox & Rect, ue: TextBox, row: ElementRow) => {
    if (!ge.lines.length) { row.lines = "not compared"; linesNotCompared.push(key); return; }
    row.lines = `${ge.lines.length}/${ue.lines.length}`;
    if (ue.lines.length !== ge.lines.length) {
      issue(key, "lines", `${ge.lines.length} line${ge.lines.length === 1 ? "" : "s"} in the design, ${ue.lines.length} in Unity`, ge);
      return;
    }
    let worst = -1, wd = 0;
    ge.lines.forEach((l, i) => { const dd = ue.lines[i].baseline - l.baseline; if (Math.abs(dd) > Math.abs(wd)) { wd = dd; worst = i; } });
    if (worst >= 0 && Math.abs(wd) > t.baselinePx + GEOMETRY_EPS) {
      issue(key, "baseline", `line ${worst + 1} of ${ge.lines.length}: baseline Δ ${fmt(wd)} px (limit ±${t.baselinePx})`, ge.lines[worst]);
    }
  };

  for (const id of ids) {
    const ge = g.elements[id], ue = u.elements[id];
    const row = newRow(id);
    rows.push(row);
    rowOf.set(id, row);
    if (!ue) {
      // a compiler-removed wrapper has no box of its own to show; one that carries text or paints cannot be removed
      const shows = ge.visible && (ge.text || !!ctx.painters?.has(id));
      if (removedSet.has(id) && !shows) { row.status = "removed"; continue; }
      row.status = "missing";
      issue(id, "missing", removedSet.has(id)
        ? `listed as removed by the compiler, but it ${ge.text ? "carries text" : "paints"} in the design and Unity has no box for it`
        : "in the design, but not in the Unity capture", ge);
      continue;
    }
    if (!ge.visible && !ue.visible) { row.status = "hidden"; continue; }
    if (ge.visible !== ue.visible) {
      row.status = "fail";
      issue(id, "visibility", ge.visible ? "visible in the design, hidden in Unity" : "hidden in the design, visible in Unity", ge.visible ? ge : ue);
      continue;
    }
    compared.push(id);
    const d: [number, number, number, number] = [r6(ue.x - ge.x), r6(ue.y - ge.y), r6(ue.w - ge.w), r6(ue.h - ge.h)];
    row.box = d;
    const m = Math.max(...d.map(Math.abs));
    if (!maxBox || m > maxBox.px) maxBox = { id, px: m };
    if (m > t.boxPx + GEOMETRY_EPS) issue(id, "box", `box Δx ${fmt(d[0])} Δy ${fmt(d[1])} Δw ${fmt(d[2])} Δh ${fmt(d[3])} px (limit ±${t.boxPx})`, ge);
    if (ge.text) lineCheck(id, ge, ue, row);
  }

  // ---- the text of the IR elements' copies in later written-out repeat items (boxes `items`; ruling R133): the same text
  // checks as the IR element's (present, visible as in the design, line count, baselines, and below its ink), named by
  // the copy (`row#3`); their boxes are not compared (the edge bands use them)
  const textCopies: { key: string; id: string; g: ItemCopy; u: ItemCopy }[] = [];
  for (const [key, gc] of Object.entries(g.items ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!gc.text) continue;
    const id = key.slice(0, key.indexOf("#")), uc = u.items?.[key];
    const row = newRow(key);
    rows.push(row);
    rowOf.set(key, row);
    if (!uc) {
      if (gc.visible) { row.status = "missing"; issue(key, "missing", `a copy in a later repeat item that carries text in the design, but not in the Unity capture`, gc); }
      else row.status = "hidden";
      continue;
    }
    if (!gc.visible && !uc.visible) { row.status = "hidden"; continue; }
    if (gc.visible !== uc.visible) {
      row.status = "fail";
      issue(key, "visibility", gc.visible ? "visible in the design, hidden in Unity" : "hidden in the design, visible in Unity", gc.visible ? gc : uc);
      continue;
    }
    lineCheck(key, gc, uc, row);
    textCopies.push({ key, id, g: gc, u: uc });
  }

  // ---- what Unity shows that the design does not have
  for (const [id, ue] of Object.entries(u.elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (id in g.elements || !ue.visible) continue;
    rows.push(newRow(id, "extra"));
    issue(id, "extra", "visible in Unity, but not an element of the design", ue);
  }

  // ---- masks (both sides, inflated by 2 px); Unity's text is masked only where the design shows the same element
  const w = gp.w, h = gp.h;
  let ssim: number | null = null, pixelsOff: number | null = null, heat: Rgba | null = null, masked: Rect[] = [], edgeMasked = 0, outsideScreen = false;
  let worst: { id: string; ssim: number } | null = null, maxDE: { id: string; deltaE: number } | null = null;
  if (sameSize) {
    const shown = (id: string) => !!g.elements[id]?.visible && !!u.elements[id]?.visible;
    /** Whether an animation sample moves the element (an animation of geometry on it or an ancestor; ruling R132). */
    const movesIn = (id: string) => !!ctx.anim && !!ctx.moving?.has(id);
    const textBoxes: Rect[] = [], textLines: Rect[] = [];
    for (const [id, e] of Object.entries(g.elements)) {
      if (!e.text || !e.visible) continue;
      textBoxes.push(e);
      textLines.push(...(e.lines.length ? e.lines : [e]));
      const o = u.elements[id];
      if (o && shown(id)) { textBoxes.push(o); textLines.push(...(o.lines.length ? o.lines : [o])); }
    }
    // the text lines of the copies in later repeat items (ruling R133): their own checks judge them. Only the lines, not the
    // copy's box: a copy has no element SSIM or colour samples of its own, so what it paints (a chip's background, a pill's
    // border) stays in the whole capture's and its containers' SSIM (fix round 1, I-1). A copy without lines (a form
    // control's value) keeps its box masked, as the IR element's line mask does
    for (const [key, e] of Object.entries(g.items ?? {})) {
      if (!e.text || !e.visible) continue;
      const own = e.lines.length ? e.lines : [e];
      textBoxes.push(...own);
      textLines.push(...own);
      const o = u.items?.[key];
      if (o?.visible) { const theirs = o.lines.length ? o.lines : [o]; textBoxes.push(...theirs); textLines.push(...theirs); }
    }
    const externalBoxes = g.external.flatMap((id) => [g.elements[id], u.external.includes(id) ? u.elements[id] : undefined]).filter((e): e is Box => !!e);
    const mask = maskRects(w, h, [...textBoxes, ...externalBoxes], 2);
    const lineMask = maskRects(w, h, [...textLines, ...externalBoxes], 2);
    // colour samples stay 1 px off text and external regions (their own 3×3 window and neighbours); the SSIM-only masks
    // below exclude just their own pixels from a sample (`edgeBand`)
    const textMask = lineMask.slice();
    const edgeBand = new Uint8Array(w * h);
    // the anti-aliased pixel row or column of a painted edge Chromium draws off the device grid: it snaps a box to whole
    // CSS px, so at scale 0.75 an edge can fall at x.25, x.5 or x.75 device px, where UI Toolkit puts it on a whole pixel
    // (Yoga); the box check measures where the edge is (findings: pixel grid)
    const offGrid = offGridEdges(compared.filter((id) => !ctx.painters || ctx.painters.has(id)).map((id) => g.elements[id]), g.scale);
    for (const m of [mask, lineMask, edgeBand]) maskRects(w, h, offGrid, 0, m);
    edgeMasked = offGrid.length;
    // outside the screen root nothing is designed: a breakpoint's coverage viewport of another aspect shows the page's
    // own background in the golden and the panel's clear colour in Unity there. It applies to any capture whose root
    // does not fill the image (in the default suite only coverage viewports); the report does not draw this mask
    const rootBox = ctx.root ? g.elements[ctx.root] : undefined;
    if (rootBox?.visible) {
      const r0 = rootBox, outside: Rect[] = [];
      if (r0.x > 0) outside.push({ x: 0, y: 0, w: r0.x, h });
      if (r0.x + r0.w < w) outside.push({ x: r0.x + r0.w, y: 0, w: w - r0.x - r0.w, h });
      if (r0.y > 0) outside.push({ x: 0, y: 0, w, h: r0.y });
      if (r0.y + r0.h < h) outside.push({ x: 0, y: r0.y + r0.h, w, h: h - r0.y - r0.h });
      for (const m of [mask, lineMask, edgeBand]) maskRects(w, h, outside, 0, m);
      outsideScreen = outside.length > 0;
    }
    masked = [...textBoxes, ...externalBoxes].filter((r) => r.w > 0 && r.h > 0).map((r) => ({ x: r6(r.x - 2), y: r6(r.y - 2), w: r6(r.w + 4), h: r6(r.h + 4) }));
    const external = new Set(g.external);
    const fullViewport = (e: Box) => e.x <= 0 && e.y <= 0 && e.x + e.w >= w && e.y + e.h >= h;

    const map = blockSsimMap(gp, up, mask);
    ssim = wholeSsim(map);
    if (ssim < t.ssimNonText - EPS) issue(WHOLE, "ssim", `whole-capture SSIM ${ssim.toFixed(5)} (limit ${t.ssimNonText})`);

    const paints = (id: string) => !ctx.painters || ctx.painters.has(id);
    const paintIndex = new Map(order.map((id, i) => [id, i]));
    /**
     * Boxes painted over the element on either side: later elements in paint order that paint something (IR), else
     * the elements it contains. A point under one of them on either side is not this element's colour.
     */
    const coveringIds = (id: string): string[] => {
      const ge = g.elements[id];
      return paintIndex.has(id)
        ? order.slice(paintIndex.get(id)! + 1).filter((x) => paints(x))
        : Object.entries(g.elements).filter(([x, e]) => x !== id && e.visible && e.w * e.h < ge.w * ge.h
          && e.x >= ge.x && e.y >= ge.y && e.x + e.w <= ge.x + ge.w && e.y + e.h <= ge.y + ge.h).map(([x]) => x);
    };
    const covering = (id: string): Rect[] =>
      coveringIds(id).flatMap((x) => [g.elements[x], u.elements[x]]).filter((e): e is Box => !!e && e.visible);
    /**
     * Whether a pixel of a text's line is hidden by a later element: one whose fill is opaque (CaptureContext.opaque), within
     * its painted shape (its box with its corner radii, half a pixel wider for the anti-aliased edge), on either side. A
     * translucent scrim, a border-only box, a picture or a shadow hides nothing: the text under it is still judged.
     */
    const hiddenBy = (id: string): ((x: number, y: number) => boolean) | null => {
      if (!ctx.opaque) return null;
      const shapes = coveringIds(id).filter((x) => ctx.opaque!.has(x))
        .flatMap((x) => [g.elements[x], u.elements[x]].filter((e): e is Box => !!e && e.visible).map((b) => ({ b, r: ctx.radii?.[x] })));
      if (!shapes.length) return null;
      return (x, y) => shapes.some(({ b, r }) => insideRounded(b, r, x + 0.5, y + 0.5, 0.5));
    };
    const onText = (x: number, y: number) => {
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (textMask[yy * w + xx]) return true;
      return false;
    };
    /** A design pixel the sample's window averages lies in an off-grid edge or outside the screen. */
    const inBand = (x: number, y: number, win: number) => {
      const r = win >> 1;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (edgeBand[yy * w + xx]) return true;
      return false;
    };
    /** `light`: the design's ink is lighter than its background (font smoothing thickens such text most). */
    interface InkLine { id: string; i: number; n: number; ratio: number | null; at: Rect; light: boolean; later: boolean; small: boolean; glow: boolean }
    const inkLines: InkLine[] = [];
    const inImage = (p: RingPoint) => p.gx >= 0 && p.gy >= 0 && p.gx < w && p.gy < h && p.ux >= 0 && p.uy >= 0 && p.ux < w && p.uy < h;
    const usable = (p: RingPoint, cover: Rect[]) => inImage(p)
      && !cover.some((l) => inside(l, p.gx, p.gy, 1)) && !onText(p.gx, p.gy) && !onText(p.ux, p.uy) && !inBand(p.gx, p.gy, p.win);
    /** Whether pixel (x, y) shares area with one of the rects. */
    const touches = (rs: readonly Rect[], x: number, y: number) => rs.some((r) => r.x < x + 1 && r.x + r.w > x && r.y < y + 1 && r.y + r.h > y);

    // the edge band of the element's own round shapes and its descendants' (outer curve and the border's inner curve, both
    // sides, in the element's region), where the scaled class's anti-aliasing ramp differs: masked on top of the element's
    // own mask for `ssimRoundEdge`; another element's curves (a sibling drawn over it) are that element's
    const within = (id: string, anc: string) => {
      for (let x: string | undefined = id; x !== undefined; x = ctx.parent?.get(x)) if (x === anc) return true;
      return false;
    };
    /** The repeat containers around an element, outermost first. */
    const containersOf = (id: string): string[] => {
      const out: string[] = [];
      for (let x = ctx.parent?.get(id); x !== undefined; x = ctx.parent?.get(x)) if (ctx.repeats?.has(x)) out.unshift(x);
      return out;
    };
    type ItemBox = Rect & { visible: boolean };
    /**
     * The later written-out repeat items' copies (boxes `items`, both sides shown) of the elements inside `owner`: a copy in a
     * later item of a repeat lies inside `owner` only when `owner` is that repeat's container or outside it (an element inside
     * the first item holds that item's elements only). Their key's suffix names the item of each repeat, innermost first.
     */
    const itemsWithin = (owner: string): { key: string; id: string; g: ItemBox; u: ItemBox }[] => {
      const out: { key: string; id: string; g: ItemBox; u: ItemBox }[] = [];
      for (const [key, gb] of Object.entries(g.items ?? {})) {
        const ub = u.items?.[key];
        if (!ub || !gb.visible || !ub.visible) continue;
        const [id, ...parts] = key.split("#");
        if (!within(id, owner)) continue;
        const cs = containersOf(id), path = cs.map(() => 0);
        parts.forEach((k, j) => { const level = cs.length - 1 - j; if (level >= 0) path[level] = Number(k); });
        if (cs.some((c, j) => path[j] !== 0 && c !== owner && within(owner, c))) continue;
        out.push({ key, id, g: gb, u: ub });
      }
      return out;
    };
    /** A border an edge band masks (an element's own, a descendant's or a later repeat item's), where each renderer draws it. */
    interface BandBorder { id: string; label: string; g: Rect; u: Rect; widths: readonly number[]; radii?: readonly number[] }
    interface Band { mask: Uint8Array; moved: boolean; fractional: boolean; borders: BandBorder[] }
    /**
     * The element's own mask with the edge band of its own and its descendants' round shapes in `region` added, and the
     * band of their straight edges where `straight` says so: an edge an animation sample moves to a fractional device offset
     * (Chromium draws it from its resampled layer, UI Toolkit on whole pixels) and, with `statics`, an edge that lies between
     * two device pixels in a static capture at a scaled viewport (the box's edge and its border's inner edge, where Chromium
     * covers the pixel partly), also of the later items of a repeat inside it (ruling R124: the boxes' `items`). A straight
     * edge's band is every pixel whose centre lies within ROUND_EDGE_BAND of that edge in the design and in Unity: an edge
     * Unity draws a device pixel away from the design's is not in it. `moved` and `fractional`: whether such edges were
     * added; `borders`: the borders whose band it masks (their colour and width are the relaxation's evidence, R129, R130).
     */
    const bandOf = (owner: string, base: Uint8Array, region: Rect, statics = false): Band => {
      const out = base.slice();
      let moved = false, fractional = false;
      const borders: BandBorder[] = [];
      const addBorder = (id: string, label: string, gb: Rect, ub: Rect) => {
        const bw = ctx.borders?.[id];
        if (bw && !borders.some((b) => b.label === label)) borders.push({ id, label, g: gb, u: ub, widths: bw, radii: ctx.radii?.[id] });
      };
      // the band reaches as far as the SSIM blocks over the region do (a moved edge's spill past the box lies in its last block)
      const rx0 = Math.max(0, Math.floor(region.x / 8) * 8), rx1 = Math.min(w, Math.ceil((region.x + region.w) / 8) * 8);
      const ry0 = Math.max(0, Math.floor(region.y / 8) * 8), ry1 = Math.min(h, Math.ceil((region.y + region.h) / 8) * 8);
      const r = { x0: rx0, x1: rx1, y0: ry0, y1: ry1 };
      for (const id of compared) {
        if (!within(id, owner)) continue;
        const isMoved = movedAtFraction(id);
        if (!isMoved && !(statics && paints(id))) continue;
        // a moved edge lies where the sample's transform puts the box; a static one where Chromium paints it (whole CSS px)
        const gb = isMoved ? g.elements[id] : paintedRect(g.elements[id], g.scale), ub = u.elements[id];
        if (!ub?.visible) continue;
        const added = markBoxEdges(out, w, h, gb, ub, ctx.borders?.[id], r);
        if (added && isMoved) moved = true;
        else if (added) fractional = true;
        addBorder(id, id, gb, ub);
      }
      const items = itemsWithin(owner);
      if (statics) for (const it of items) {
        if (!paints(it.id)) continue;
        const gb = paintedRect(it.g, g.scale);
        if (markBoxEdges(out, w, h, gb, it.u, ctx.borders?.[it.id], r)) fractional = true;
        addBorder(it.id, it.key, gb, it.u);
      }
      // a curve where the design draws it: where the sample's transform puts a moved box, else where Chromium paints it
      const curves = (id: string, label: string, gbox: Rect | null, ubox: Rect | null, isMoved = false) => {
        const radii = ctx.radii?.[id];
        if (!radii) return;
        const placed = gbox ? (isMoved ? gbox : paintedRect(gbox, g.scale)) : null;
        for (const b of [placed, ubox]) {
          if (!b) continue;
          const x0 = Math.max(rx0, Math.floor(b.x) - 2), x1 = Math.min(rx1, Math.ceil(b.x + b.w) + 2);
          const y0 = Math.max(ry0, Math.floor(b.y) - 2), y1 = Math.min(ry1, Math.ceil(b.y + b.h) + 2);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (nearCurve(b, ctx.borders?.[id], radii, x, y, ROUND_EDGE_BAND)) out[y * w + x] = 1;
        }
        if (placed && ubox) addBorder(id, label, placed, ubox);
      };
      for (const id of compared) if (within(id, owner)) curves(id, id, g.elements[id]?.visible ? g.elements[id] : null, u.elements[id]?.visible ? u.elements[id] : null, movedAtFraction(id));
      for (const it of items) curves(it.id, it.key, it.g, it.u);
      return { mask: out, moved, fractional, borders };
    };

    /**
     * The largest colour difference outside a band, as the element's colour limit measures it (ruling R129): the ΔE2000 of
     * the design's 3×3 mean at every pixel of `region` whose window lies wholly outside `m`, against Unity's closest 3×3 mean
     * within 1 px (bestDeltaE). Every window counts, not a mean over the element.
     */
    const maxWindowDe = (m: Uint8Array, region: Rect): { de: number; x: number; y: number } => {
      const x0 = Math.max(1, Math.floor(region.x)), x1 = Math.min(w - 1, Math.ceil(region.x + region.w));
      const y0 = Math.max(1, Math.floor(region.y)), y1 = Math.min(h - 1, Math.ceil(region.y + region.h));
      const gd = gp.data, ud = up.data;
      let best = { de: 0, x: -1, y: -1 };
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        let clear = true, same = true;
        for (let yy = y - 1; yy <= y + 1 && clear; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
          const p = yy * w + xx;
          if (m[p]) { clear = false; break; }
          const o = p * 4;
          if (same && (gd[o] !== ud[o] || gd[o + 1] !== ud[o + 1] || gd[o + 2] !== ud[o + 2])) same = false;
        }
        if (!clear || same) continue;
        const r = bestDeltaE(gp, x, y, up, x, y, 3);
        if (r.de > best.de) best = { de: r.de, x, y };
      }
      return best;
    };
    /** What a relaxation's band leaves to show that the difference lies in it, and why not when it does not (rulings R129, R130). */
    interface Evidence { ok: boolean; why: string; minBlock: number; maxDe: number; ring: number | null; width: number | null }
    /**
     * The evidence an edge-band relaxation needs, at every viewport: outside the band, every SSIM block of the region (each
     * at its best offset of up to 1 px) meets ssimElement and every 3×3 window is within deltaE2000 of Unity's closest within
     * 1 px (pixel level, not the region's mean); every border the band masks has its centre pixel (each side of
     * BORDER_SAMPLE_PX or more) within the file's deltaE2000Ring, a side under that width giving no evidence, and its drawn
     * width within RING_WIDTH_PX of the design's. The centre colour is sampled as deltaE2000Ring samples it, except on a
     * border an animation sample moves (ruling R132); there the width and the windows still hold.
     */
    const evidenceOf = (band: Band, region: Rect): Evidence => {
      const blocks = regionSsimShiftedBlocks(gp, up, band.mask, region, 1);
      const px = maxWindowDe(band.mask, region);
      let ring: { de: number; where: string; a: number[]; b: number[] } | null = null;
      let width: { d: number; where: string; design: number; unity: number } | null = null;
      let none = "";
      for (const b of band.borders) {
        const cover = covering(b.id);
        // the centre colour as deltaE2000Ring samples it, unless an animation sample moves the border (Chromium draws a
        // moving element from its resampled layer, whose border's centre pixel blends; its colour is judged in the static
        // captures): an element a sample does not move gets the static checks (ruling R132)
        const moves = movesIn(b.id);
        const full = moves ? [0, 0, 0, 0] : b.widths.map((v) => (v >= BORDER_SAMPLE_PX ? v : 0));
        let any = moves;
        for (const p of full.some((v) => v > 0) ? ringPoints(b.g, b.u, full, ["border"], b.radii) : []) {
          if (!usable(p, cover)) continue;
          any = true;
          const r = bestDeltaE(gp, p.gx, p.gy, up, p.ux, p.uy, p.win);
          if (!ring || r.de > ring.de) ring = { de: r.de, where: `${b.label} ${p.where}`, a: r.a, b: r.b };
        }
        if (!none && !moves && (b.widths.some((v) => v > 0 && v < BORDER_SAMPLE_PX) || !any))
          none = `the border of ${b.label} (a side under ${BORDER_SAMPLE_PX} device px, or no usable point on it) gives no evidence of its colour`;
        const skip = (x: number, y: number) => onText(x, y) || cover.some((c) => inside(c, x, y));
        for (const wp of borderWidths(gp, b.g, up, b.u, b.widths, b.radii, BORDER_SAMPLE_PX, skip)) {
          const d = Math.abs(wp.design - wp.unity);
          if (!width || d > width.d) width = { d, where: `${b.label} ${wp.where}`, design: wp.design, unity: wp.unity };
        }
      }
      const ev = { minBlock: blocks.min, maxDe: px.de, ring: ring ? (ring as { de: number }).de : null, width: width ? (width as { d: number }).d : null };
      // every condition that does not hold, not only the first (a failing capture shows all its causes; ruling R133)
      const r = ring as { de: number; where: string; a: number[]; b: number[] } | null, wd = width as { d: number; where: string; design: number; unity: number } | null;
      const why = [
        blocks.min < t.ssimElement - EPS ? `an SSIM block outside the band, the 8 px block at (${blocks.minAt[0]}, ${blocks.minAt[1]}), is ${blocks.min.toFixed(5)} (below ${t.ssimElement}: not confined to it)` : "",
        px.de > t.deltaE2000 + EPS ? `outside the band, (${px.x}, ${px.y}) differs by ΔE2000 ${px.de.toFixed(2)} (a 3×3 mean; limit ${t.deltaE2000}: not confined to it)` : "",
        none,
        r && r.de > t.deltaE2000Ring + EPS ? `the centre of ${r.where} differs by ΔE2000 ${r.de.toFixed(2)} (design ${hex(r.a)}, Unity ${hex(r.b)}; limit ${t.deltaE2000Ring}): the border in that band is not the design's` : "",
        wd && wd.d > RING_WIDTH_PX + EPS ? `${wd.where} is drawn ${wd.unity.toFixed(2)} device px wide, the design's ${wd.design.toFixed(2)} (limit ±${RING_WIDTH_PX}): the border in that band is not the design's` : "",
      ].filter((x) => x).join(", and ");
      return { ok: !why, why, ...ev };
    };

    /** A key's repeat containers (outermost first) and its item in each (its suffix names them innermost first; ruling R133). */
    const placeOf = (id: string, key: string): { cs: string[]; path: number[] } => {
      const cs = containersOf(id), path = cs.map(() => 0);
      key.slice(id.length).split("#").slice(1).forEach((k, j) => { const level = cs.length - 1 - j; if (level >= 0) path[level] = Number(k); });
      return { cs, path };
    };
    /**
     * What paints after the text `key` of element `id` and may lie over its lines (ruling R141, fix round 3 N-5): every IR
     * element and every written-out repeat copy later in paint order that paints something, on both sides, and the outer
     * shadow each casts (`shadows`; a copy's placed by its own box). A later item of a repeat paints after an earlier one;
     * inside one item the IR's paint order holds. Null when the paint order is unknown.
     */
    const laterLayers = (id: string, key: string): Rect[] | null => {
      if (!paintIndex.has(id)) return null;
      const me = placeOf(id, key), at = paintIndex.get(id)!;
      const after = (x: string, k: string) => {
        if (!paintIndex.has(x)) return false;
        const o = placeOf(x, k);
        for (let j = 0; j < Math.min(me.cs.length, o.cs.length) && me.cs[j] === o.cs[j]; j++) if (me.path[j] !== o.path[j]) return o.path[j] > me.path[j];
        return paintIndex.get(x)! > at;
      };
      const out: Rect[] = [];
      const add = (x: string, sides: (Box | undefined)[]) => {
        const sh = ctx.shadows?.[x], ir = g.elements[x];
        for (const b of sides) {
          if (!b || !b.visible) continue;
          if (b.w > 0 && b.h > 0) out.push(b);
          if (sh && ir) out.push({ x: b.x + sh.x - ir.x, y: b.y + sh.y - ir.y, w: b.w + sh.w - ir.w, h: b.h + sh.h - ir.h });
        }
      };
      for (const x of order) if (paints(x) && after(x, x)) add(x, [g.elements[x], u.elements[x]]);
      for (const k of new Set([...Object.keys(g.items ?? {}), ...Object.keys(u.items ?? {})])) {
        const x = k.slice(0, k.indexOf("#"));
        if (k !== key && paints(x) && after(x, k)) add(x, [g.items?.[k], u.items?.[k]]);
      }
      return out;
    };

    /**
     * A text's ink per line (an IR element's, or its copy's in a later repeat item, `key` naming it; ruling R133): colour
     * and extent now, the amount after every line of the capture is measured. `id`: the IR element (its font size, its
     * text shadow and what is painted over it).
     */
    const inkCheck = (id: string, key: string, ge: TextBox, ue: TextBox, row: ElementRow) => {
      // the font size in device px: the IR's, else the line box over the kit's largest ratio (4/3), never more than the real size
      const px = ctx.fontPx?.[id] ?? ge.lines[0].h * 0.75;
      let wDe: { de: number; i: number; a: number[]; b: number[]; limit: number } | null = null, maxDe = 0;
      let wX: { i: number; dl: number; dr: number; dw: number; worst: number } | null = null;
      let wDir: { dir: number; i: number; a: number[]; b: number[] } | null = null, wAmount: { ratio: number; i: number } | null = null;
      // ruling R141: a hairline line is small text drawn in its own colour (the one the capture recorded for this element or
      // this copy) at full opacity (its own and its ancestors', an animation sample's running value included), all of the
      // line in it (no span of another colour: fix round 3, N-6), and nothing painted later lies over it (a later element or
      // copy, or the shadow it casts: N-5); then R138's conditions (isHairline)
      const own = key === id ? g.elements[id] : g.items?.[key];
      const declared = own?.color && own.opacity !== undefined ? { rgb: own.color.slice(0, 3), alpha: own.color[3] * own.opacity } : undefined;
      const later = declared && px <= HAIRLINE_MAX_PX && declared.alpha >= 1 - 1e-6 ? laterLayers(id, key) : null;
      const mayBeHairline = !!later;
      const hidden = hiddenBy(id);
      let covered = 0;
      ge.lines.forEach((gl, i) => {
        const win = grow(unionRect(gl, ue.lines[i]), 1);
        if (hidden && everyPixel(win, w, h, hidden)) { covered++; linesCovered.push(`${key}: line ${i + 1} of ${ge.lines.length}`); return; }
        const a = inkIn(gp, win, hidden ?? undefined);
        if (!a) return;
        const b = inkIn(up, win, hidden ?? undefined);
        // the ink's horizontal extent: spacing, kerning or alignment moves it inside a box of the right size (geometry:
        // the box limit, whatever the text size)
        if (b) {
          // where Unity's first and last glyphs sit against the design's: the ink profile near each end (an em, or half
          // the line) matched to the design's, so stroke thickness and anti-aliasing (renderer differences) do not count
          const em = Math.max(1, Math.min(gl.h, (a.right - a.left) / 2));
          const dl = endShift(a, b, a.left, a.left + em, b.left - a.left), dr = endShift(a, b, a.right - em, a.right, b.right - a.right);
          const dw = dr - dl, worst = Math.max(Math.abs(dl), Math.abs(dr), Math.abs(dw));
          if (!wX || worst > wX.worst) wX = { i, dl, dr, dw, worst };
        }
        // a hairline line (rulings R138, R141): its lightness measures coverage; its ink's colour direction is judged, and its
        // ink amount only within HAIRLINE_INK_BAND (a stroke drawn a row off scatters, a missing or added glyph does not)
        if (b && mayBeHairline && !gl.mixed && !later!.some((r) => r.x < win.x + win.w && r.x + r.w > win.x && r.y < win.y + win.h && r.y + r.h > win.y) &&
            isHairline(a, declared!)) {
          const dir = angleBetween(a.dirSrgb, b.dirSrgb);
          if (!wDir || dir > wDir.dir) wDir = { dir, i, a: a.ink, b: b.ink };
          // the ink amount against the text colour on both sides (each pixel's distance from the background over the colour's),
          // not each side's own ink colour: a stroke drawn faint everywhere is little ink, not a full stroke of a lighter colour
          const sum = (x: Float64Array) => { let v = 0; for (const d of x) v += d; return v; };
          const ratio = sum(b.dists) / Math.max(sum(a.dists), 1);
          const off = Math.max(HAIRLINE_INK_BAND[0] - ratio, ratio - HAIRLINE_INK_BAND[1]);
          if (off > EPS && (!wAmount || off > Math.max(HAIRLINE_INK_BAND[0] - wAmount.ratio, wAmount.ratio - HAIRLINE_INK_BAND[1]))) wAmount = { ratio, i };
          return;
        }
        inkLines.push({ id: key, i, n: ge.lines.length, ratio: b ? b.coverage / Math.max(a.coverage, MIN_INK_PX) : null, at: gl, light: lumaOf(a.ink) > lumaOf(a.bg), later: i >= 1 && px < t.textInkLaterBelowPx, small: px <= t.textInkSmallPx, glow: !!ctx.textShadows?.has(id) });
        if (b) {
          const de = deltaE2000(a.ink, b.ink), limit = inkColourLimit(t, px, i);
          maxDe = Math.max(maxDe, de);
          if (!wDe || de - limit > wDe.de - wDe.limit) wDe = { de, i, a: a.ink, b: b.ink, limit };
        }
      });
      if (covered) row.lines = `${row.lines}, ${covered} not judged (covered)`;
      if (wX) {
        const x = wX as { i: number; dl: number; dr: number; dw: number; worst: number };
        row.inkExtent = r6(x.worst);
        if (x.worst > t.boxPx + GEOMETRY_EPS) {
          issue(key, "inkExtent", `line ${x.i + 1} of ${ge.lines.length}: text ink left Δ ${fmt(x.dl)} px, right Δ ${fmt(x.dr)} px, width Δ ${fmt(x.dw)} px (limit ±${t.boxPx} px)`, ge.lines[x.i]);
        }
      }
      if (wDir) {
        const x = wDir as { dir: number; i: number; a: number[]; b: number[] };
        row.inkDirection = r6(x.dir);
        if (x.dir > t.textInkDirection + EPS) {
          issue(key, "ink", `line ${x.i + 1} of ${ge.lines.length}: a hairline line (fewer than ${HAIRLINE_PIXELS} fully covered pixels in the design): its ink's colour direction from the background differs by ${x.dir.toFixed(2)}° (design ${hex(x.a)}, Unity ${hex(x.b)}; limit ${t.textInkDirection}°)`, ge.lines[x.i]);
        }
      }
      if (wAmount) {
        const x = wAmount as { ratio: number; i: number };
        issue(key, "inkCoverage", `line ${x.i + 1} of ${ge.lines.length}: a hairline line: Unity draws ${x.ratio.toFixed(2)}× the design's text ink (expected ${HAIRLINE_INK_BAND[0]}–${HAIRLINE_INK_BAND[1]}×): glyphs missing, added or another size`, ge.lines[x.i]);
      }
      if (wDe) {
        const x = wDe as { de: number; i: number; a: number[]; b: number[]; limit: number };
        row.ink = r6(maxDe);
        if (x.de > x.limit + EPS) {
          issue(key, "ink", `line ${x.i + 1} of ${ge.lines.length}: text colour ΔE2000 ${x.de.toFixed(2)}, design ${hex(x.a)}, Unity ${hex(x.b)} (limit ${x.limit} at ${Number(px.toFixed(2))} px${x.i >= 1 && px < t.textInkLaterBelowPx ? ", a later line" : ""})`, ge.lines[x.i]);
        }
      }
    };

    /** Elements below ssimElement, judged after every other check (a measured lower limit needs those to pass). */
    const lowSsim: { id: string; s0: number; best: number; region: Rect; carriesText: boolean; shadow: boolean }[] = [];
    // ssimRoundEdge: at a scaled viewport any element with round shapes in its region (the layout scale's ramp); at every
    // viewport a round element without text (a radio, an avatar ring) and, in an animation sample, an element that moves at a
    // fractional device offset (Chromium draws it from its resampled layer); a round element's border side samples, worst
    // first, for its evidence
    const edgeLimit = t.ssimRoundEdge < t.ssimElement - EPS;
    const roundEdge = edgeLimit && !!ctx.radii;
    const scaledClass = ctx.viewportClass === "scaled";
    const movedAtFraction = (id: string) => movesIn(id) && !!g.elements[id] && fractionalBox(g.elements[id]);
    const roundWithoutText = (id: string) => !!ctx.radii?.[id] && !(g.elements[id]?.text && g.elements[id].lines.length > 0);
    const edgeScope = (id: string) => edgeLimit && (scaledClass ? roundEdge || movedAtFraction(id) : roundWithoutText(id) || movedAtFraction(id));
    for (const id of compared) {
      const ge = g.elements[id], ue = u.elements[id], row = rowOf.get(id)!;
      if (external.has(id)) continue;
      const shadow = ctx.shadows?.[id];
      const carriesText = ge.text && ge.lines.length > 0;

      // element SSIM over box ∪ shadow rect (a text element without lines, i.e. an input or select, keeps its box masked)
      if ((!ge.text || carriesText) && ge.w >= MIN_ELEMENT && ge.h >= MIN_ELEMENT && id !== ctx.root && !fullViewport(ge)) {
        const region = shadow ? unionRect(ge, shadow) : ge;
        const m0 = carriesText ? lineMask : mask;
        const s0 = carriesText ? regionSsimShifted(gp, up, lineMask, region, 0) : regionSsim(map, region);
        if (!Number.isNaN(s0)) {
          row.ssim = r6(s0);
          let best = s0;
          if (s0 < t.ssimElement - EPS) { const s1 = regionSsimShifted(gp, up, m0, region, 1); row.ssimShifted = r6(s1); best = Math.max(s0, s1); }
          if (!worst || best < worst.ssim) worst = { id, ssim: r6(best) };
          if (best < t.ssimElement - EPS) lowSsim.push({ id, s0, best, region, carriesText, shadow: !!shadow });
        }
      }

      const cover = covering(id);
      // the golden's painted rect (Chromium snaps a box to whole CSS px) places the ring samples and the corner curves
      const gPaint = paintedRect(ge, g.scale);
      // grid and centre-line points off the rounded corners' anti-aliased curves (outer, and inner inside a border)
      const curve = (p: RingPoint) => nearCurve(gPaint, ctx.borders?.[id], ctx.radii?.[id], p.gx, p.gy) || nearCurve(ue, ctx.borders?.[id], ctx.radii?.[id], p.ux, p.uy);
      const solid = !ctx.backgrounds || ctx.backgrounds.has(id);
      let use: RingPoint[] | null = null;
      if ((solid || ctx.borders?.[id]) && paints(id) && Math.min(gPaint.w, gPaint.h) < THIN_PX) {
        // a line (a divider, a bar): 3×3 windows would straddle its edges, so it is sampled one pixel at a time on the
        // centre line each renderer paints; it must be there in Unity, and the off-grid mask never covers it
        const horizontal = gPaint.h <= gPaint.w;
        const gThick = horizontal ? gPaint.h : gPaint.w, uThick = horizontal ? ue.h : ue.w;
        if (gThick >= 0.5 && uThick < 0.5) {
          issue(id, "box", `a line ${Number(gThick.toFixed(2))} device px thick in the design is ${Number(uThick.toFixed(2))} px in Unity (UI Toolkit snaps its edges to whole device px)`, ge);
        }
        const centre = (a: number, len: number) => Math.floor(a + len / 2 + 1e-6);
        // along the line on a pixel the renderer covers fully (the line's ends may be off the grid too)
        const along = (a: number, len: number, f: number) => {
          const lo = Math.ceil(a - 1e-6), hi = Math.floor(a + len + 1e-6) - 1;
          return hi < lo ? Math.floor(a + len / 2) : Math.min(hi, Math.max(lo, Math.floor(a + f * len)));
        };
        const pts = Array.from(new Map(FX.map((f): [string, RingPoint] => {
          const p: RingPoint = horizontal
            ? { where: `the centre line at ${f * 100}%`, kind: "edge", gx: along(gPaint.x, gPaint.w, f), gy: centre(gPaint.y, gPaint.h), ux: along(ue.x, ue.w, f), uy: centre(ue.y, ue.h), win: 1 }
            : { where: `the centre line at ${f * 100}%`, kind: "edge", gx: centre(gPaint.x, gPaint.w), gy: along(gPaint.y, gPaint.h, f), ux: centre(ue.x, ue.w), uy: along(ue.y, ue.h, f), win: 1 };
          return [`${p.gx},${p.gy}`, p];
        })).values());
        let covered = 0;
        // under half a device pixel on both sides (a closed drawer, 0 px wide) it paints no pixel: nothing to sample
        const painted = gThick >= 0.5 || uThick >= 0.5;
        use = !painted ? [] : pts.filter((p) => {
          if (!inImage(p)) return false;
          if (touches(cover, p.gx, p.gy)) { covered++; return false; }
          return !touches(textLines, p.gx, p.gy) && !touches(textLines, p.ux, p.uy) && !edgeBand[p.gy * w + p.gx] && !curve(p);
        });
        // covered by later elements, it shows nothing to compare; otherwise a line left without a sample is a failure
        if (painted && !use.length && covered < pts.length) {
          issue(id, "color", `a line ${Number(gThick.toFixed(2))} device px thick: no colour sample left on its centre line (on text, an off-grid edge or a curve)`, ge);
        }
      } else if (solid) {
        // background colour: the grid, then the ring inside the border, never silently nothing
        const ix0 = Math.max(ge.x, ue.x), iy0 = Math.max(ge.y, ue.y), ix1 = Math.min(ge.x + ge.w, ue.x + ue.w), iy1 = Math.min(ge.y + ge.h, ue.y + ue.h);
        const cw = ix1 - ix0, ch = iy1 - iy0;
        const pts: RingPoint[] = [];
        if (cw > 0 && ch > 0) {
          const grid: [number, number][] = cw < MIN_ELEMENT || ch < MIN_ELEMENT
            ? [[Math.floor(ix0 + cw / 2), Math.floor(iy0 + ch / 2)]]
            : FY.flatMap((fy) => FX.map((fx) => [Math.floor(ix0 + 6 + (cw - 12) * fx), Math.floor(iy0 + 6 + (ch - 12) * fy)] as [number, number]));
          for (const [x, y] of grid) pts.push({ where: `(${x}, ${y})`, kind: "edge", gx: x, gy: y, ux: x, uy: y, win: 3 });
        }
        // and where the design is flat (a picture's detail or an edge is measured by SSIM)
        use = pts.filter((p) => usable(p, cover) && !curve(p) && flatAt(gp, p.gx, p.gy));
        if (!use.length) use = ringPoints(gPaint, ue, ctx.borders?.[id], ["edge"], ctx.radii?.[id]).filter((p) => usable(p, cover));
      }
      // a round element without text: the middle of each border side of 2 device px or more (its centre pixel covered on
      // both renderers): its ring lies in the edge band an edge-band relaxation masks, so a missing or wrong-colour ring
      // shows here (an element that carries text samples its border with its ring below), and its drawn width across the
      // middle of each side and each round corner's diagonal (ruling R127; a ring a pixel thinner keeps its colour sample)
      const sides = ctx.borders?.[id];
      if (!carriesText && ctx.radii?.[id] && paints(id) && sides && sides.some((v) => v > 0)) {
        let worst: { de: number; p: RingPoint; a: number[]; b: number[] } | null = null;
        const full = sides.map((v) => (v >= BORDER_SAMPLE_PX ? v : 0));
        for (const p of full.some((v) => v > 0) ? ringPoints(gPaint, ue, full, ["border"], ctx.radii[id]) : []) {
          if (!usable(p, cover)) continue;
          const r = bestDeltaE(gp, p.gx, p.gy, up, p.ux, p.uy, p.win);
          if (!worst || r.de > worst.de) worst = { de: r.de, p, a: r.a, b: r.b };
        }
        // the ring's colour at every viewport; where ssimRoundEdge applies, also the evidence for it (none: no evidence)
        // (not where an animation sample moves it: Chromium draws the moving element from its resampled layer, so a thin
        // border's centre pixel blends with its edges there; the ring's colour is judged in every state's static capture)
        if (worst) {
          row.ring = r6(worst.de);
          if (!movesIn(id) && worst.de > t.deltaE2000Ring + EPS) {
            issue(id, "color", `ring ${worst.p.where}: ΔE2000 ${worst.de.toFixed(2)}, design ${hex(worst.a)}, Unity ${hex(worst.b)} (limit ${t.deltaE2000Ring}): the ring's colour differs`,
              { x: worst.p.gx - 1, y: worst.p.gy - 1, w: 3, h: 3 });
          }
        }
        let thick: { d: number; where: string; design: number; unity: number } | null = null;
        const skip = (x: number, y: number) => onText(x, y) || cover.some((c) => inside(c, x, y));
        for (const wp of borderWidths(gp, gPaint, up, ue, sides, ctx.radii[id], BORDER_SAMPLE_PX, skip)) {
          const d = Math.abs(wp.design - wp.unity);
          if (!thick || d > thick.d) thick = { d, where: wp.where, design: wp.design, unity: wp.unity };
        }
        if (thick) {
          row.ringWidth = r6(thick.d);
          // not where a sample moves it: Chromium draws a moving element from its resampled layer
          if (!movesIn(id) && thick.d > RING_WIDTH_PX + EPS) {
            issue(id, "edge", `ring ${thick.where}: drawn ${thick.unity.toFixed(2)} device px wide, the design's ${thick.design.toFixed(2)} (limit ±${RING_WIDTH_PX}): the ring's width differs`, ge);
          }
        }
      }
      if (use) {
        row.samples = use.length;
        if (!use.length) notSampled.push(id);
        let bestS: { de: number; p: RingPoint; a: number[]; b: number[] } | null = null;
        for (const p of use) {
          const r = bestDeltaE(gp, p.gx, p.gy, up, p.ux, p.uy, p.win);
          if (!bestS || r.de > bestS.de) bestS = { de: r.de, p, a: r.a, b: r.b };
        }
        if (bestS) {
          row.deltaE = r6(bestS.de);
          if (!maxDE || bestS.de > maxDE.deltaE) maxDE = { id, deltaE: r6(bestS.de) };
          // a raster picture resampled at a scaled viewport (ruling R125; off elsewhere)
          const limit = ctx.pictures?.has(id) ? Math.max(t.deltaE2000, t.deltaE2000ResampledPicture) : t.deltaE2000;
          if (bestS.de > limit + EPS) {
            issue(id, "color", `ΔE2000 ${bestS.de.toFixed(2)} at ${bestS.p.where}: design ${hex(bestS.a)}, Unity ${hex(bestS.b)} (limit ${limit}${limit > t.deltaE2000 ? " for a raster picture resampled at a scaled viewport" : ""})`,
              { x: bestS.p.gx - 1, y: bestS.p.gy - 1, w: 3, h: 3 });
          }
        }
      }

      // an element that carries text and paints: background, border and corner shape around the text
      if (carriesText && paints(id)) {
        // a corner sample whose window reaches a round shape's edge band, where the scaled class's ramp differs, and whose
        // window pixels outside that band (at least ROUND_EDGE_KEPT of them, the evidence) meet deltaE2000: its difference
        // lies in the band. A window with fewer pixels outside the band keeps deltaE2000
        const roundBand = (p: RingPoint) => {
          if (!(t.deltaE2000RoundEdge > t.deltaE2000) || !cornerInRoundBand(p, gPaint, ue, ctx.borders?.[id], ctx.radii?.[id])) return false;
          const radii = ctx.radii![id], border = ctx.borders?.[id];
          const outside = (x: number, y: number, design: boolean) => !nearCurve(design ? gPaint : ue, border, radii, x, y, ROUND_EDGE_BAND);
          const kept = bestDeltaEKept(gp, p.gx, p.gy, up, p.ux, p.uy, p.win, outside, ROUND_EDGE_KEPT);
          return kept.de <= t.deltaE2000 + EPS;
        };
        // at a scaled viewport, a corner sample whose window reaches the band of the element's straight edges between two
        // device pixels (its box's and its border's inner edges) and whose window pixels outside that band and the round-edge
        // band (at least ROUND_EDGE_KEPT of them) meet deltaE2000: its difference lies in those bands
        let straight: Uint8Array | null | undefined;
        const fractionalBand = (p: RingPoint) => {
          if (!scaledClass || p.kind !== "corner" || !(t.deltaE2000FractionalEdge > t.deltaE2000)) return false;
          if (straight === undefined) {
            const m = new Uint8Array(w * h);
            const r0 = { x0: Math.floor(Math.min(gPaint.x, ue.x)) - 2, x1: Math.ceil(Math.max(gPaint.x + gPaint.w, ue.x + ue.w)) + 2,
              y0: Math.floor(Math.min(gPaint.y, ue.y)) - 2, y1: Math.ceil(Math.max(gPaint.y + gPaint.h, ue.y + ue.h)) + 2 };
            straight = markBoxEdges(m, w, h, gPaint, ue, ctx.borders?.[id], r0) ? m : null;
          }
          const m = straight;
          if (!m) return false;
          const r = p.win >> 1;
          let reaches = false;
          for (let dy = -r; dy <= r && !reaches; dy++) for (let dx = -r; dx <= r; dx++) {
            const gx = p.gx + dx, gy = p.gy + dy, ux = p.ux + dx, uy = p.uy + dy;
            if ((gx >= 0 && gy >= 0 && gx < w && gy < h && m[gy * w + gx]) || (ux >= 0 && uy >= 0 && ux < w && uy < h && m[uy * w + ux])) { reaches = true; break; }
          }
          if (!reaches) return false;
          const radii = ctx.radii?.[id], border = ctx.borders?.[id];
          const outside = (x: number, y: number, design: boolean) => !m[y * w + x] && !nearCurve(design ? gPaint : ue, border, radii, x, y, ROUND_EDGE_BAND);
          return bestDeltaEKept(gp, p.gx, p.gy, up, p.ux, p.uy, p.win, outside, ROUND_EDGE_KEPT).de <= t.deltaE2000 + EPS;
        };
        const samples: { de: number; p: RingPoint; a: number[]; b: number[]; limit: number }[] = [];
        let maxRing = -1;
        for (const p of ringPoints(gPaint, ue, ctx.borders?.[id], ["edge", "border", "corner"], ctx.radii?.[id])) {
          if (!usable(p, cover)) continue;
          const r = bestDeltaE(gp, p.gx, p.gy, up, p.ux, p.uy, p.win);
          const limit = roundBand(p) ? t.deltaE2000RoundEdge : fractionalBand(p) ? t.deltaE2000FractionalEdge : t.deltaE2000;
          maxRing = Math.max(maxRing, r.de);
          samples.push({ de: r.de, p, a: r.a, b: r.b, limit });
        }
        // a corner that needs its relaxed limit needs the element's evidence too (rulings R129, R130): its pixels outside the
        // edge bands of its class (round shapes; straight edges between device pixels at a scaled viewport, moved edges in an
        // animation sample), its border's centre colour and width
        let cornerWhy = "";
        if (samples.some((x) => x.limit > t.deltaE2000 && x.de > t.deltaE2000 + EPS)) {
          const region = shadow ? unionRect(ge, shadow) : ge;
          const ev = evidenceOf(bandOf(id, lineMask, region, scaledClass), region);
          row.bandEvidence = { minBlock: r6(ev.minBlock), maxDe: r6(ev.maxDe), ring: ev.ring === null ? null : r6(ev.ring), width: ev.width === null ? null : r6(ev.width) };
          if (!ev.ok) { cornerWhy = ev.why; for (const x of samples) x.limit = t.deltaE2000; }
        }
        let bestR: (typeof samples)[number] | null = null;
        for (const x of samples) if (!bestR || x.de - x.limit > bestR.de - bestR.limit) bestR = x;
        if (bestR) {
          row.edge = r6(maxRing);
          if (bestR.de > bestR.limit + EPS) {
            const band = bestR.limit === t.deltaE2000 ? (cornerWhy ? `; the corner limits of edge bands need the evidence: ${cornerWhy}` : "")
              : bestR.limit === t.deltaE2000RoundEdge ? ` for a corner in the edge band of round shapes`
              : ` for a corner in the band of straight edges between device pixels`;
            issue(id, "edge", `${bestR.p.where}: ΔE2000 ${bestR.de.toFixed(2)}, design ${hex(bestR.a)}, Unity ${hex(bestR.b)} (limit ${bestR.limit}${band}): background, border or corner shape differs`,
              { x: bestR.p.gx - 2, y: bestR.p.gy - 2, w: 5, h: 5 });
          }
        }
      }

      // text ink per line: colour now; the amount after all lines of the capture are measured
      if (carriesText && ue.lines.length === ge.lines.length) inkCheck(id, id, ge, ue, row);

      // shadow band
      if (shadow) {
        const a = bandMean(gp, shadow, ge), b = bandMean(up, shadow, ge, { a: gp, mask });
        if (a && b) {
          const de = deltaE2000(a, b);
          row.band = r6(de);
          if (de > t.deltaE2000 + EPS) issue(id, "shadow", `shadow band ΔE2000 ${de.toFixed(2)}: design ${hex(a)}, Unity ${hex(b)} (limit ${t.deltaE2000})`, shadow);
        }
      }
    }

    // the copies' text in later repeat items: the same ink checks as the IR element's (ruling R133)
    for (const c of textCopies) if (c.g.lines.length && c.u.lines.length === c.g.lines.length) inkCheck(c.id, c.key, c.g, c.u, rowOf.get(c.key)!);

    // text ink amount: with smoothing-off designs Unity draws 0.92-1.08 of the design's ink for correct text
    // (docs/findings/text-ink.md; with macOS font smoothing on it was 0.69-1.03, more for light text). A line's ratio
    // must lie between the measured ratio and identity (each with the tolerance), and, when the capture has 3 or more
    // measured lines of the same polarity, within the tolerance of their median ratio, which cancels the renderer and
    // leaves a wrong weight, size or glyph run
    const medianOf = (light: boolean) => {
      const ratios = inkLines.filter((l) => l.light === light).map((l) => l.ratio).filter((r): r is number => r !== null).sort((a, b) => a - b);
      return ratios.length >= 3 ? ratios[(ratios.length - 1) >> 1] / 2 + ratios[ratios.length >> 1] / 2 : null;
    };
    const medians = { light: medianOf(true), dark: medianOf(false) };
    const medianTolerance = (l: InkLine) => (l.small ? Math.max(t.textInkMedianTolerance, t.textInkMedianToleranceSmall) : t.textInkMedianTolerance);
    const band = (l: InkLine) => {
      const c = l.later ? t.textInkCoverageLater : t.textInkCoverage;
      let lo = t.textInkRatio * (1 - c), hi = 1 + c;
      if (l.small) { lo = Math.min(lo, t.textInkBandSmall[0]); hi = Math.max(hi, t.textInkBandSmall[1]); }
      // a blurred text-shadow's glow inside the line counts as ink (measured)
      if (l.glow) hi = Math.max(hi, t.textInkShadowHigh);
      return { lo, hi };
    };
    const worstInk = new Map<string, { l: InkLine; score: number }>();
    for (const l of inkLines) {
      const { lo, hi } = band(l);
      const median = l.light ? medians.light : medians.dark;
      const score = l.ratio === null ? Infinity : Math.max(lo - l.ratio, l.ratio - hi, median === null ? -Infinity : Math.abs(l.ratio / median - 1) - medianTolerance(l));
      const prev = worstInk.get(l.id);
      if (!prev || score > prev.score) worstInk.set(l.id, { l, score });
    }
    for (const [id, { l, score }] of worstInk) {
      rowOf.get(id)!.inkRatio = l.ratio === null ? 0 : r6(l.ratio);
      if (score <= EPS) continue;
      const head = `line ${l.i + 1} of ${l.n}`, tail = "weight, size or glyphs differ";
      const { lo, hi } = band(l);
      if (l.ratio === null) issue(id, "inkCoverage", `${head}: no text ink in Unity`, l.at);
      else if (l.ratio < lo - EPS || l.ratio > hi + EPS) {
        issue(id, "inkCoverage", `${head}: Unity draws ${l.ratio.toFixed(2)}× the design's text ink (expected ${lo.toFixed(2)}–${hi.toFixed(2)}×): ${tail}`, l.at);
      } else {
        const median = (l.light ? medians.light : medians.dark)!;
        issue(id, "inkCoverage", `${head}: text ink ${l.ratio.toFixed(2)}× the design's, ${pct(l.ratio / median - 1)} against the median ${median.toFixed(2)}× of this capture's ${l.light ? "light" : "dark"} text (limit ±${Math.round(medianTolerance(l) * 100)} %): ${tail}`, l.at);
      }
    }

    // element SSIM below ssimElement: a measured lower limit when the element's every other check passed
    const otherIssue = new Set(issues.filter((i) => i.kind !== "ssim").map((i) => i.id));
    for (const l of lowSsim) {
      const row = rowOf.get(l.id)!;
      const relaxed = relaxedSsimLimit(t, l.region.w * l.region.h, !!ctx.pictures?.has(l.id), !!ctx.rotated?.has(l.id));
      if (relaxed && !otherIssue.has(l.id) && l.best >= relaxed.limit - EPS) { row.ssimLimit = relaxed.limit; continue; }
      let roundWhy = "", fractionalWhy = "";
      const base = l.carriesText ? lineMask : mask;
      /** A band's relaxation: its evidence (rulings R129, R130), recorded on the row; null when it holds. */
      const withEvidence = (band: Band): string | null => {
        const ev = evidenceOf(band, l.region);
        row.bandEvidence = { minBlock: r6(ev.minBlock), maxDe: r6(ev.maxDe), ring: ev.ring === null ? null : r6(ev.ring), width: ev.width === null ? null : r6(ev.width) };
        return ev.ok ? null : ev.why;
      };
      if (edgeScope(l.id)) {
        const band = bandOf(l.id, base, l.region);
        const banded = regionSsimShifted(gp, up, band.mask, l.region, 1);
        row.ssimRoundEdgeMasked = r6(banded);
        const confined = banded >= t.ssimElement - EPS;
        let failed: string | null = null;
        if (confined && !otherIssue.has(l.id) && l.best >= t.ssimRoundEdge - EPS) {
          failed = withEvidence(band);
          if (failed === null) { row.ssimLimit = t.ssimRoundEdge; continue; }
        }
        roundWhy = `; ${banded.toFixed(5)} with the edge band of round shapes${band.moved ? " and moved edges" : ""} masked` + (!confined ? ` (below ${t.ssimElement}: not confined to that band)`
          : failed !== null ? `, but ${failed}` : otherIssue.has(l.id) ? `, the limit ${t.ssimRoundEdge} for it needs its other checks to pass` : `, below ${t.ssimRoundEdge} unmasked`);
      }
      // at a scaled viewport: the straight edges that lie between two device pixels as well (ssimFractionalEdge)
      if (scaledClass && t.ssimFractionalEdge < t.ssimElement - EPS) {
        const wide = bandOf(l.id, base, l.region, true);
        if (wide.fractional) {
          const fs = regionSsimShifted(gp, up, wide.mask, l.region, 1);
          row.ssimFractionalEdgeMasked = r6(fs);
          let failed: string | null = null;
          if (fs >= t.ssimElement - EPS && !otherIssue.has(l.id) && l.best >= t.ssimFractionalEdge - EPS) {
            failed = withEvidence(wide);
            if (failed === null) { row.ssimLimit = t.ssimFractionalEdge; continue; }
          }
          fractionalWhy = `; ${fs.toFixed(5)} with the straight edges between device pixels masked as well` + (fs < t.ssimElement - EPS ? ` (below ${t.ssimElement}: not confined to them)`
            : failed !== null ? `, but ${failed}` : otherIssue.has(l.id) ? `, the limit ${t.ssimFractionalEdge} for it needs its other checks to pass` : `, below ${t.ssimFractionalEdge} unmasked`);
        }
      }
      // at a scaled viewport: a vector picture's drawn edges (ssimVectorEdge)
      let vectorWhy = "";
      if (scaledClass && t.ssimVectorEdge < t.ssimElement - EPS && ctx.vectors?.has(l.id)) {
        const vmask = base.slice();
        const kept = markVectorEdges(vmask, gp, l.region);
        if (kept.kept >= VECTOR_KEPT * kept.all) {
          const vs = regionSsimShifted(gp, up, vmask, l.region, 1);
          row.ssimVectorEdgeMasked = r6(vs);
          let failed: string | null = null;
          if (vs >= t.ssimElement - EPS && !otherIssue.has(l.id) && l.best >= t.ssimVectorEdge - EPS) {
            const bw = ctx.borders?.[l.id];
            failed = withEvidence({ mask: vmask, moved: false, fractional: false,
              borders: bw ? [{ id: l.id, label: l.id, g: paintedRect(g.elements[l.id], g.scale), u: u.elements[l.id], widths: bw, radii: ctx.radii?.[l.id] }] : [] });
            if (failed === null) { row.ssimLimit = t.ssimVectorEdge; continue; }
          }
          vectorWhy = `; ${vs.toFixed(5)} with the vector's edge band masked` + (vs < t.ssimElement - EPS ? ` (below ${t.ssimElement}: not confined to it)`
            : failed !== null ? `, but ${failed}` : otherIssue.has(l.id) ? `, the limit ${t.ssimVectorEdge} for it needs its other checks to pass` : `, below ${t.ssimVectorEdge} unmasked`);
        } else vectorWhy = `; its edge band leaves ${kept.kept} of ${kept.all} pixels compared (under half): no evidence for ${t.ssimVectorEdge}`;
      }
      const why = relaxed ? (otherIssue.has(l.id) ? `; the limit ${relaxed.limit} for ${relaxed.why} needs its other checks to pass` : `; ${relaxed.limit} for ${relaxed.why}`) : "";
      issue(l.id, "ssim", `element SSIM ${l.s0.toFixed(5)} (${row.ssimShifted!.toFixed(5)} with offsets up to 1 px) over the ${l.carriesText ? "box with its text lines copied from the design" : "box"}${l.shadow ? " and baked shadow" : ""} (limit ${t.ssimElement}${why}${roundWhy}${fractionalWhy}${vectorWhy})`, l.region);
    }

    const diff = difference(gp, up, mask, wantHeat);
    pixelsOff = r6(diff.off);
    heat = diff.image;
  }

  const failing = new Set(issues.map((i) => i.id));
  for (const r of rows) if (r.status === "ok" && failing.has(r.id)) r.status = "fail";
  return {
    verdict: {
      capture: g.capture, pass: issues.length === 0, ssim: ssim === null ? null : r6(ssim), issues, size: [gp.w, gp.h],
      worstElement: worst, maxBoxDelta: maxBox, maxDeltaE: maxDE, pixelsOff, linesNotCompared, linesCovered, notSampled, translucent, masked, offGridEdges: edgeMasked, outsideScreen, elements: rows,
    },
    heat,
  };
}

/**
 * Compares one Unity capture with its golden. `removed`: elements the compiler removed (absent in Unity by design).
 * `ctx`: what the IR adds (paint order, shadows, backgrounds); without it every element counts as painting a
 * background and nothing has a shadow.
 */
export function compareCapture(golden: Side, unity: Side, removed: string[], t: Thresholds, ctx: CaptureContext = {}): CaptureVerdict {
  return analyze(golden, unity, removed, t, ctx, false).verdict;
}

// ---- screen ------------------------------------------------------------------------------------------------------

type MatrixEntry = CaptureJob & { name: string };
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const tryJson = (file: string): unknown => { try { return readJson(file); } catch { return undefined; } };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function readBoxesFile(file: string, side: string): Record<string, CaptureBoxes> {
  let json: unknown;
  try { json = readJson(file); } catch (e) { throw new Error(`${side} boxes.json (${file}) cannot be read: ${(e as Error).message}`); }
  if (!isObj(json)) throw new Error(`${side} boxes.json (${file}) is not an object of captures`);
  for (const [name, b] of Object.entries(json)) {
    const errs = validateBoxes(b);
    if (errs.length) throw new Error(`${side} boxes.json (${file}): capture ${name} is invalid: ${errs.slice(0, 3).join("; ")}`);
  }
  return json as Record<string, CaptureBoxes>;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  let failure: { e: unknown } | null = null;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    for (let it = queue.shift(); it !== undefined && !failure; it = queue.shift()) {
      try { await fn(it); } catch (e) { failure ??= { e }; }
    }
  }));
  if (failure) throw (failure as { e: unknown }).e;
}

function animationStrips(entries: MatrixEntry[]): AnimStrip[] {
  const strips = new Map<string, AnimStrip>();
  for (const e of entries) {
    if (!e.anim) continue;
    const key = JSON.stringify([e.viewport, e.anim.sampled, e.anim.from, e.state, e.apply]);
    let s = strips.get(key);
    if (!s) {
      s = { element: e.anim.sampled[0].elementId, sampled: e.anim.sampled.map((r) => r.elementId), viewport: e.viewport, frames: [] };
      strips.set(key, s);
    }
    s.frames.push({ capture: e.name, time: e.anim.time });
  }
  for (const s of strips.values()) s.frames.sort((a, b) => a.time - b.time);
  return [...strips.values()];
}

/**
 * Compares every golden capture of an export folder (`<exportDir>/goldens/<capture>.png` + `boxes.json`) with the
 * Unity capture folder, which mirrors it (`<unityDir>/<capture>.png` + `boxes.json` with the same keys). A golden
 * capture without a Unity one is not run (the screen does not pass); Unity captures without a golden are listed as
 * extra. Captures are compared in parallel.
 */
/** The `notCaptured` entries of a Unity capture's boxes.meta.json: capture name -> reason (empty when absent or unreadable). */
function readNotCaptured(file: string): Record<string, string> {
  const meta = tryJson(file);
  const out: Record<string, string> = {};
  if (isObj(meta) && Array.isArray(meta.notCaptured))
    for (const n of meta.notCaptured)
      if (isObj(n) && typeof n.capture === "string") out[n.capture] = typeof n.reason === "string" && n.reason ? n.reason : "not captured by Unity";
  return out;
}

/** The colour space and colour path of a Unity capture's boxes.meta.json (a meta without a path: the gamma composite). */
function readColour(file: string): { space: string; path: string; compositeInProject: boolean | null } | null {
  const meta = tryJson(file);
  const unity = isObj(meta) && isObj(meta.unity) ? meta.unity : null;
  if (!unity || typeof unity.colorSpace !== "string") return null;
  return {
    space: unity.colorSpace, path: typeof unity.colorPath === "string" ? unity.colorPath : "gamma-composite",
    compositeInProject: typeof unity.gammaCompositeInProject === "boolean" ? unity.gammaCompositeInProject : null,
  };
}

/** The warning of a capture through the gamma composite in a Linear project none of whose scenes or prefabs has the component. */
export const NO_COMPOSITE_WARNING = "Linear colour space, captured through the gamma composite, but no scene or prefab of the project has " +
  "DesignUiGammaComposite: in game the screen blends translucent colours and text edges in linear light and will not match this verdict; " +
  "add Design UI > Gamma Composite with the design PanelSettings (ignore this if code adds it at runtime)";

/** The warning of a capture that shows translucent colours blended in linear light (an on-screen panel of a Linear project). */
export const LINEAR_PANEL_WARNING = "Linear colour space, colour path Linear Panel: Unity blends translucent colours in linear light, " +
  "the design in sRGB, so they differ from the design (up to ΔE2000 22 measured); to show them as designed, render the panel " +
  "through DesignUiGammaComposite and set the profile's colour path to Gamma Composite";

export async function compareScreen(exportDir: string, unityDir: string, t: Thresholds, opts: CompareOptions = {}): Promise<ScreenVerdict> {
  const t0 = performance.now();
  const goldensDir = path.join(exportDir, "goldens");
  const goldenBoxesFile = path.join(goldensDir, "boxes.json");
  if (!fs.existsSync(goldenBoxesFile)) throw new Error(`${exportDir} is not a design export (no goldens/boxes.json)`);
  const goldenBoxes = readBoxesFile(goldenBoxesFile, "design");
  const notes: string[] = [], warnings: string[] = [];

  const matrix = tryJson(path.join(goldensDir, "matrix.json"));
  const entries: MatrixEntry[] = isObj(matrix) && Array.isArray(matrix.captures) ? (matrix.captures as MatrixEntry[]) : [];
  if (!entries.length) notes.push("goldens/matrix.json not found: captures in name order, no animation strips");
  const byName = new Map(entries.map((e) => [e.name, e]));
  const names = entries.length
    ? [...entries.map((e) => e.name).filter((n) => n in goldenBoxes), ...Object.keys(goldenBoxes).filter((n) => !byName.has(n)).sort()]
    : Object.keys(goldenBoxes).sort();
  const bad = names.find((n) => !/^[^/\\\0]+$/.test(n) || n.includes(".."));
  if (bad !== undefined) throw new Error(`invalid capture name ${JSON.stringify(bad)} in the design export: capture names never contain path separators or ".."`);
  const platform = isObj(matrix) && typeof matrix.chromium === "string" ? { chromium: matrix.chromium, platform: String(matrix.platform ?? "") } : null;

  let ix: IrIndex | null = null;
  const irFile = path.join(exportDir, "screen.ir.json");
  if (fs.existsSync(irFile)) {
    try { ix = indexIr(readJson(irFile)); } catch (e) { warnings.push(`screen.ir.json could not be read (${(e as Error).message}): shadow bands, paint order, background and border checks were skipped`); }
  } else warnings.push("screen.ir.json not found: shadow bands, paint order, background and border checks were skipped");

  const exportReport = tryJson(path.join(exportDir, "export-report.json"));
  const screen = ix?.screen || (isObj(exportReport) && typeof exportReport.screen === "string" ? exportReport.screen : "") || path.basename(path.resolve(exportDir));

  let removed = opts.removed;
  if (!removed) {
    const manifest = tryJson(path.join(unityDir, ".design-ui.json"));
    removed = isObj(manifest) && Array.isArray(manifest.removedElements) ? manifest.removedElements.filter((x): x is string => typeof x === "string") : [];
  }

  // a Unity capture folder counts only with the capture-done marker, which Unity writes last
  const finished = fs.existsSync(path.join(unityDir, "capture-done.json"));
  const unityBoxesFile = path.join(unityDir, "boxes.json");
  const unityBoxes = finished && fs.existsSync(unityBoxesFile) ? readBoxesFile(unityBoxesFile, "Unity") : {};
  const unityNotCaptured = finished ? readNotCaptured(path.join(unityDir, "boxes.meta.json")) : {};
  const meta = readColour(path.join(unityDir, "boxes.meta.json"));
  const colour = meta ? { space: meta.space, path: meta.path } : null;
  if (meta?.space === "Linear" && meta.path === "linear-panel") warnings.push(LINEAR_PANEL_WARNING);
  if (meta?.space === "Linear" && meta.path === "gamma-composite" && meta.compositeInProject === false) warnings.push(NO_COMPOSITE_WARNING);
  const notRunReasons: Record<string, string> = {};
  const runnable: string[] = [];
  for (const name of names) {
    if (!fs.existsSync(path.join(goldensDir, `${name}.png`))) notRunReasons[name] = "the design capture PNG is missing from the export";
    else if (!finished) notRunReasons[name] = "Unity capture did not finish";
    else if (unityNotCaptured[name] !== undefined) notRunReasons[name] = unityNotCaptured[name];
    else if (!fs.existsSync(path.join(unityDir, `${name}.png`))) notRunReasons[name] = "no Unity capture PNG";
    else if (!unityBoxes[name]) notRunReasons[name] = "no entry in the Unity boxes.json";
    else runnable.push(name);
  }
  const known = new Set(names);
  const unityPngs = finished && fs.existsSync(unityDir) ? fs.readdirSync(unityDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : [];
  const extra = Array.from(new Set([...Object.keys(unityBoxes), ...unityPngs])).filter((n) => !known.has(n)).sort();

  if (opts.diffDir) fs.mkdirSync(opts.diffDir, { recursive: true });
  const results = new Map<string, CaptureVerdict>();
  const concurrency = opts.concurrency ?? Math.max(1, Math.min(4, os.availableParallelism?.() ?? 4));
  await pool(runnable, concurrency, async (name) => {
    const c0 = performance.now();
    const [gpng, upng] = await Promise.all([
      fs.promises.readFile(path.join(goldensDir, `${name}.png`)).then(decodePngAsync),
      fs.promises.readFile(path.join(unityDir, `${name}.png`)).then(decodePngAsync),
    ]);
    const entry = byName.get(name);
    const gb = goldenBoxes[name];
    const ctx: CaptureContext = ix
      ? captureContext(ix, entry ?? { state: name.split("@")[0], viewport: gb.viewport, apply: [] }, gb)
      : {};
    const cls = viewportClassOf(ix?.scaledViewports, entry?.viewport ?? gb.viewport);
    ctx.viewportClass = cls;
    const { verdict, heat } = analyze({ png: gpng, boxes: gb }, { png: upng, boxes: unityBoxes[name] }, removed!, thresholdsFor(t, cls), ctx, !!opts.diffDir);
    verdict.info = entry ? {
      state: entry.state, viewport: entry.viewport, viewportClass: cls, apply: entry.apply,
      anim: entry.anim ? { element: entry.anim.sampled[0].elementId, sample: entry.anim.sample, time: entry.anim.time, series: entry.anim.sampled.map((r) => r.elementId).join(",") } : null,
    } : null;
    verdict.diff = null;
    if (heat && opts.diffDir) {
      const file = path.join(opts.diffDir, `${name}.png`);
      await fs.promises.writeFile(file, await encodePngAsync(heat));
      verdict.diff = file;
    }
    verdict.ms = Math.round((performance.now() - c0) * 10) / 10;
    results.set(name, verdict);
  });

  const captures = runnable.map((n) => results.get(n)!);
  const notRun = names.filter((n) => n in notRunReasons);
  // jobs the design shows in no context: no golden exists, so nothing can be compared for them
  const hiddenReasons: Record<string, string> = {};
  if (isObj(matrix) && Array.isArray(matrix.hidden))
    for (const h of matrix.hidden) if (isObj(h) && typeof h.name === "string") hiddenReasons[h.name] = typeof h.reason === "string" && h.reason ? h.reason : "hidden in the design";
  const hidden = Object.keys(hiddenReasons).sort();
  const status = !names.length || notRun.length || captures.some((c) => !c.pass) ? "fail" : hidden.length ? "incomplete" : "pass";
  const timings: Record<string, number> = {};
  if (isObj(exportReport) && isObj(exportReport.timings)) {
    if (typeof exportReport.timings.lint === "number") timings.lint = exportReport.timings.lint;
    if (typeof exportReport.totalMs === "number") timings.export = exportReport.totalMs;
  }
  Object.assign(timings, opts.timings ?? {});
  timings.compare = Math.round(performance.now() - t0);
  if (!names.length) notes.push("the export has no golden captures");
  // per viewport class: a capture's viewport from its matrix entry, else from its golden boxes
  const byClass: Partial<Record<ViewportClass, ClassSummary>> = {};
  const count = (name: string, what: "pass" | "fail" | "notRun") => {
    const vp = byName.get(name)?.viewport ?? goldenBoxes[name]?.viewport;
    if (!vp) return;
    const cls = viewportClassOf(ix?.scaledViewports, vp);
    const c = (byClass[cls] ??= { viewports: [], pass: 0, fail: 0, notRun: 0 });
    if (!c.viewports.some((v) => v[0] === vp[0] && v[1] === vp[1])) c.viewports.push([vp[0], vp[1]]);
    c[what]++;
  };
  for (const c of captures) count(c.capture, c.pass ? "pass" : "fail");
  for (const n of notRun) count(n, "notRun");
  for (const c of Object.values(byClass)) c!.viewports.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  return {
    screen, pass: status === "pass", status,
    captures, notRun, notRunReasons, hidden, hiddenReasons, extra, thresholds: t, timings, platform, removed: [...removed!].sort(),
    animations: animationStrips(entries.filter((e) => known.has(e.name))), byClass, warnings, notes, colour,
  };
}

/** One line per viewport class of a verdict: `exact 2560×1440, 1920×1080: 40 pass, 0 fail` (not-run captures when any). */
export function classLines(v: Pick<ScreenVerdict, "byClass">): string[] {
  return (["exact", "scaled"] as ViewportClass[]).filter((k) => v.byClass?.[k]).map((k) => {
    const c = v.byClass[k]!;
    return `${k} ${c.viewports.map((x) => `${x[0]}×${x[1]}`).join(", ")}: ${c.pass} pass, ${c.fail} fail${c.notRun ? `, ${c.notRun} not run` : ""}`;
  });
}

const KIND_RANK: IssueKind[] = ["size", "missing", "extra", "visibility", "lines", "box", "baseline", "inkExtent", "ssim", "edge", "color", "ink", "inkCoverage", "shadow"];

/** Short issue lines (`<capture>: <element>: <detail>`), most structural first, then (unless left out) not-run captures. */
export function summarizeIssues(v: ScreenVerdict, limit = 20, opts: { notRun?: boolean } = {}): string[] {
  const all = v.captures.flatMap((c) => c.issues.map((i) => ({ c: c.capture, i })));
  all.sort((a, b) => KIND_RANK.indexOf(a.i.kind) - KIND_RANK.indexOf(b.i.kind));
  const lines = all.map(({ c, i }) => `${c}: ${i.id === WHOLE ? "whole capture" : i.id}: ${i.detail}`);
  if (opts.notRun !== false) {
    lines.push(...v.notRun.map((n) => `${n}: not run (${v.notRunReasons[n] ?? "no Unity capture"})`));
    lines.push(...(v.hidden ?? []).map((n) => `${n}: hidden in the design, not compared (${v.hiddenReasons?.[n] ?? "no context shows it"})`));
  }
  return lines.slice(0, limit);
}
