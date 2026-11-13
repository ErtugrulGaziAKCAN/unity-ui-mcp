/**
 * Fidelity comparison of Unity captures against the design's goldens (spec §11, §15): this decides "one to one".
 *
 * Per capture (static, pseudo-state and animation sample alike, with the same thresholds):
 * - every golden element: present in Unity (unless the compiler removed it as a wrapper that carries no text and
 *   paints nothing), the same visibility (hidden on both sides: nothing else is compared; hidden on one side: a
 *   visibility issue, never a box delta), border box within ±`boxPx`, text with the same line count and every line's
 *   baseline within ±`baselinePx` (inputs and selects report no lines: not compared); every element Unity shows that
 *   the design does not have is an `extra` issue;
 * - copy-mask SSIM (ssim.ts): whole capture ≥ `ssimNonText`; per visible element ≥ 16×16 px ≥ `ssimElement` over its
 *   golden box joined with its active baked-shadow rect. Non-text elements use the pinned copy-mask (text element boxes
 *   copied from the design); an element that carries text uses a mask of its text lines only, so its background,
 *   border and corners count. When the plain value fails, each block may take its best value with the Unity image
 *   offset by up to 1 px, so the ±1 px box allowance (a move or a 1-px size change) cannot fail the element;
 * - colour (samples.ts): elements that paint a background get a 5×3 grid of 3×3 means inside both boxes (inset 6 px;
 *   one centre sample under 16 px), skipping points under later elements that paint or on text lines; when every
 *   grid point is covered, samples just inside the border take over; an element left without any sample is listed
 *   as "not sampled", never skipped silently. Elements that carry text and paint also get ring samples (background
 *   inside the border, the border, the corner diagonals for the radius). Every sample is ΔE2000 ≤ `deltaE2000` against
 *   the closest Unity colour within 1 px;
 * - text ink per line: the ink colour (ΔE2000 ≤ `textInkDeltaE` for text of at least `textInkFullPx` device px, the
 *   measured `textInkDeltaESmall` limit below that size) and the ink amount: Unity's relative to the design's between
 *   `textInkRatio` and 1 (each ± `textInkCoverage`), and within ±`textInkMedianTolerance` of the capture's median ratio
 *   for text of the same polarity (light on dark, dark on light) when it has 3 or more such lines; this catches a wrong
 *   text colour, weight or size. The macOS golden's font smoothing makes the design's stems heavier than Unity's, more
 *   for light text and at small sizes (docs/findings/text-ink.md), which these limits absorb;
 * - shadow band: the mean colour of each active outer shadow's band (shadow rect minus element box), ΔE2000 ≤
 *   `deltaE2000`, so a faint missing shadow fails although SSIM dilutes it.
 * Masks are the union of both sides inflated by 2 px; Unity text is masked only for elements the design also shows.
 * Colours are compared premultiplied (a translucent Unity pixel counts as its colour over black). Line widths are not
 * compared (findings §4: the caret route's line rects differ from Chromium's by more than a pixel at the same break).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rgba } from "../bake/png.js";
import type { CaptureBoxes } from "../boxes/types.js";
import { validateBoxes } from "../boxes/validate.js";
import type { CaptureApply, CaptureJob } from "../capture/matrix.js";
import { deltaE2000, hex } from "./color.js";
import { captureContext, indexIr, type CaptureContext, type IrIndex } from "./context.js";
import { decodePngAsync, encodePngAsync } from "./png.js";
import { bestDeltaE, inkIn, ringPoints, type RingPoint } from "./samples.js";
import { blockSsimMap, maskRects, regionSsim, regionSsimShifted, unionRect, wholeSsim, type Rect } from "./ssim.js";

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
}

/** `tools/design-export/fidelity-thresholds.json`, the only place the thresholds live (keys starting with `$` are comments). */
export const THRESHOLDS_FILE = fileURLToPath(new URL("../../fidelity-thresholds.json", import.meta.url));
const THRESHOLD_KEYS = ["boxPx", "baselinePx", "deltaE2000", "ssimNonText", "ssimElement", "textInkDeltaE", "textInkRatio", "textInkCoverage",
  "textInkFullPx", "textInkMedianTolerance"] as const;

export function readThresholds(file: string = THRESHOLDS_FILE): Thresholds {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of THRESHOLD_KEYS) if (typeof raw[k] !== "number" || !Number.isFinite(raw[k])) throw new Error(`${file}: "${k}" must be a number`);
  const table = raw.textInkDeltaESmall;
  const pairs = Array.isArray(table) && table.length > 0 && table.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0));
  const ordered = pairs && (table as number[][]).every((p, i, a) => i === 0 || p[0] < a[i - 1][0]) && (table as number[][]).at(-1)![0] === 0;
  if (!ordered) throw new Error(`${file}: "textInkDeltaESmall" must be [device px, ΔE2000] pairs from the largest size down to 0`);
  const small = table as number[][];
  if (small[0][0] >= (raw.textInkFullPx as number) || small.some(([, de]) => de < (raw.textInkDeltaE as number)))
    throw new Error(`${file}: "textInkDeltaESmall" must start below textInkFullPx with limits of at least textInkDeltaE`);
  return {
    ...(Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, raw[k] as number])) as Omit<Thresholds, "textInkDeltaESmall">),
    textInkDeltaESmall: (table as number[][]).map(([px, de]) => [px, de] as [number, number]),
  };
}

/** The ink colour limit for text of `px` device px (font size). */
export function inkColourLimit(t: Thresholds, px: number): number {
  if (px >= t.textInkFullPx) return t.textInkDeltaE;
  return (t.textInkDeltaESmall.find(([min]) => px >= min) ?? t.textInkDeltaESmall[t.textInkDeltaESmall.length - 1])[1];
}

export type IssueKind = "size" | "missing" | "extra" | "visibility" | "lines" | "box" | "baseline" | "ssim" | "edge" | "color" | "ink" | "inkCoverage" | "shadow";
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
  /** Largest background sample ΔE2000. */
  deltaE: number | null;
  /** Background samples taken: null when the element paints no background; 0 = not sampled. */
  samples: number | null;
  /** Largest ring sample ΔE2000 (text-carrying elements: background inside the border, border, corners). */
  edge: number | null;
  /** Shadow band ΔE2000. */
  band: number | null;
  /** Largest text ink colour ΔE2000 over the lines. */
  ink: number | null;
  /** Unity's text ink amount relative to the design's, for the element's worst line (0: no ink in Unity). */
  inkRatio: number | null;
  /** `<design>/<Unity>` line counts; "not compared" for text without DOM lines. */
  lines: string | null;
}

/** The capture's setup from matrix.json (null when the export has no matrix). */
export interface CaptureInfo {
  state: string;
  viewport: [number, number];
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
  /** Elements that paint a background but had no colour sample left (every point covered or on text). */
  notSampled: string[];
  /** Unity pixels with alpha below 255 (compared premultiplied). */
  translucent: number;
  /** Regions copied from the design before the pinned SSIM (text element boxes, external; inflated by 2 px). */
  masked: Rect[];
  elements: ElementRow[];
  /** Set by compareScreen. */
  info?: CaptureInfo | null;
  /** Difference image written by compareScreen (absolute path), else null. */
  diff?: string | null;
  /** Compare time of this capture in ms (compareScreen). */
  ms?: number;
}

export interface AnimStrip {
  /** The animated element the series is named after, and every element it samples. */
  element: string;
  sampled: string[];
  viewport: [number, number];
  frames: { capture: string; time: number }[];
}

export interface ScreenVerdict {
  screen: string;
  pass: boolean;
  captures: CaptureVerdict[];
  /** Golden captures without a Unity capture (never a pass). */
  notRun: string[];
  notRunReasons: Record<string, string>;
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
  /** Checks the comparison had to skip for the whole screen (e.g. no IR: no shadow bands). Shown as a warning. */
  warnings: string[];
  /** Other remarks (e.g. no capture matrix: name order, no animation strips). */
  notes: string[];
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
const MIN_ELEMENT = 16;
const MIN_INK_PX = 16;
const FX = [0.1, 0.3, 0.5, 0.7, 0.9], FY = [0.25, 0.5, 0.75];
const fmt = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)} %`;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lumaOf = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

type Box = CaptureBoxes["elements"][string];
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
  const removedSet = new Set(removed);
  const issue = (id: string, kind: IssueKind, detail: string, at?: Rect) => issues.push(at ? { id, kind, detail, at } : { id, kind, detail });
  const newRow = (id: string, status: ElementRow["status"] = "ok"): ElementRow =>
    ({ id, status, box: null, ssim: null, ssimShifted: null, deltaE: null, samples: null, edge: null, band: null, ink: null, inkRatio: null, lines: null });

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
    if (m > t.boxPx + EPS) issue(id, "box", `box Δx ${fmt(d[0])} Δy ${fmt(d[1])} Δw ${fmt(d[2])} Δh ${fmt(d[3])} px (limit ±${t.boxPx})`, ge);
    if (ge.text) {
      if (!ge.lines.length) { row.lines = "not compared"; linesNotCompared.push(id); }
      else {
        row.lines = `${ge.lines.length}/${ue.lines.length}`;
        if (ue.lines.length !== ge.lines.length) {
          issue(id, "lines", `${ge.lines.length} line${ge.lines.length === 1 ? "" : "s"} in the design, ${ue.lines.length} in Unity`, ge);
        } else {
          let worst = -1, wd = 0;
          ge.lines.forEach((l, i) => { const dd = ue.lines[i].baseline - l.baseline; if (Math.abs(dd) > Math.abs(wd)) { wd = dd; worst = i; } });
          if (worst >= 0 && Math.abs(wd) > t.baselinePx + EPS) {
            issue(id, "baseline", `line ${worst + 1} of ${ge.lines.length}: baseline Δ ${fmt(wd)} px (limit ±${t.baselinePx})`, ge.lines[worst]);
          }
        }
      }
    }
  }

  // ---- what Unity shows that the design does not have
  for (const [id, ue] of Object.entries(u.elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (id in g.elements || !ue.visible) continue;
    rows.push(newRow(id, "extra"));
    issue(id, "extra", "visible in Unity, but not an element of the design", ue);
  }

  // ---- masks (both sides, inflated by 2 px); Unity's text is masked only where the design shows the same element
  const w = gp.w, h = gp.h;
  let ssim: number | null = null, pixelsOff: number | null = null, heat: Rgba | null = null, masked: Rect[] = [];
  let worst: { id: string; ssim: number } | null = null, maxDE: { id: string; deltaE: number } | null = null;
  if (sameSize) {
    const shown = (id: string) => !!g.elements[id]?.visible && !!u.elements[id]?.visible;
    const textBoxes: Rect[] = [], textLines: Rect[] = [];
    for (const [id, e] of Object.entries(g.elements)) {
      if (!e.text || !e.visible) continue;
      textBoxes.push(e);
      textLines.push(...(e.lines.length ? e.lines : [e]));
      const o = u.elements[id];
      if (o && shown(id)) { textBoxes.push(o); textLines.push(...(o.lines.length ? o.lines : [o])); }
    }
    const externalBoxes = g.external.flatMap((id) => [g.elements[id], u.external.includes(id) ? u.elements[id] : undefined]).filter((e): e is Box => !!e);
    const mask = maskRects(w, h, [...textBoxes, ...externalBoxes], 2);
    const lineMask = maskRects(w, h, [...textLines, ...externalBoxes], 2);
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
    const covering = (id: string): Rect[] => {
      const ge = g.elements[id];
      const ids = paintIndex.has(id)
        ? order.slice(paintIndex.get(id)! + 1).filter((x) => paints(x))
        : Object.entries(g.elements).filter(([x, e]) => x !== id && e.visible && e.w * e.h < ge.w * ge.h
          && e.x >= ge.x && e.y >= ge.y && e.x + e.w <= ge.x + ge.w && e.y + e.h <= ge.y + ge.h).map(([x]) => x);
      return ids.flatMap((x) => [g.elements[x], u.elements[x]]).filter((e): e is Box => !!e && e.visible);
    };
    const onText = (x: number, y: number) => {
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (lineMask[yy * w + xx]) return true;
      return false;
    };
    /** `light`: the design's ink is lighter than its background (font smoothing thickens such text most). */
    interface InkLine { id: string; i: number; n: number; ratio: number | null; at: Rect; light: boolean }
    const inkLines: InkLine[] = [];
    const usable = (p: RingPoint, cover: Rect[]) => p.gx >= 0 && p.gy >= 0 && p.gx < w && p.gy < h && p.ux >= 0 && p.uy >= 0 && p.ux < w && p.uy < h
      && !cover.some((l) => inside(l, p.gx, p.gy, 1)) && !onText(p.gx, p.gy) && !onText(p.ux, p.uy);

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
          if (best < t.ssimElement - EPS) {
            issue(id, "ssim", `element SSIM ${s0.toFixed(5)} (${row.ssimShifted!.toFixed(5)} with offsets up to 1 px) over the ${carriesText ? "box with its text lines copied from the design" : "box"}${shadow ? " and baked shadow" : ""} (limit ${t.ssimElement})`, region);
          }
        }
      }

      const cover = covering(id);
      // background colour: the grid, then the ring inside the border, never silently nothing
      if (!ctx.backgrounds || ctx.backgrounds.has(id)) {
        const ix0 = Math.max(ge.x, ue.x), iy0 = Math.max(ge.y, ue.y), ix1 = Math.min(ge.x + ge.w, ue.x + ue.w), iy1 = Math.min(ge.y + ge.h, ue.y + ue.h);
        const cw = ix1 - ix0, ch = iy1 - iy0;
        const pts: RingPoint[] = [];
        if (cw > 0 && ch > 0) {
          const grid: [number, number][] = cw < MIN_ELEMENT || ch < MIN_ELEMENT
            ? [[Math.floor(ix0 + cw / 2), Math.floor(iy0 + ch / 2)]]
            : FY.flatMap((fy) => FX.map((fx) => [Math.floor(ix0 + 6 + (cw - 12) * fx), Math.floor(iy0 + 6 + (ch - 12) * fy)] as [number, number]));
          for (const [x, y] of grid) pts.push({ where: `(${x}, ${y})`, kind: "edge", gx: x, gy: y, ux: x, uy: y, win: 3 });
        }
        let use = pts.filter((p) => usable(p, cover));
        if (!use.length) use = ringPoints(ge, ue, ctx.borders?.[id], ["edge"]).filter((p) => usable(p, cover));
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
          if (bestS.de > t.deltaE2000 + EPS) {
            issue(id, "color", `ΔE2000 ${bestS.de.toFixed(2)} at ${bestS.p.where}: design ${hex(bestS.a)}, Unity ${hex(bestS.b)} (limit ${t.deltaE2000})`,
              { x: bestS.p.gx - 1, y: bestS.p.gy - 1, w: 3, h: 3 });
          }
        }
      }

      // an element that carries text and paints: background, border and corner shape around the text
      if (carriesText && paints(id)) {
        let bestR: { de: number; p: RingPoint; a: number[]; b: number[] } | null = null;
        for (const p of ringPoints(ge, ue, ctx.borders?.[id], ["edge", "border", "corner"])) {
          if (!usable(p, cover)) continue;
          const r = bestDeltaE(gp, p.gx, p.gy, up, p.ux, p.uy, p.win);
          if (!bestR || r.de > bestR.de) bestR = { de: r.de, p, a: r.a, b: r.b };
        }
        if (bestR) {
          row.edge = r6(bestR.de);
          if (bestR.de > t.deltaE2000 + EPS) {
            issue(id, "edge", `${bestR.p.where}: ΔE2000 ${bestR.de.toFixed(2)}, design ${hex(bestR.a)}, Unity ${hex(bestR.b)} (limit ${t.deltaE2000}): background, border or corner shape differs`,
              { x: bestR.p.gx - 2, y: bestR.p.gy - 2, w: 5, h: 5 });
          }
        }
      }

      // text ink per line: colour now; the amount after all lines of the capture are measured
      if (carriesText && ue.lines.length === ge.lines.length) {
        // the font size in device px: the IR's, else the line box over the kit's largest ratio (4/3), never more than the real size
        const px = ctx.fontPx?.[id] ?? ge.lines[0].h * 0.75;
        const limit = inkColourLimit(t, px);
        let wDe: { de: number; i: number; a: number[]; b: number[] } | null = null;
        ge.lines.forEach((gl, i) => {
          const win = grow(unionRect(gl, ue.lines[i]), 1);
          const a = inkIn(gp, win);
          if (!a) return;
          const b = inkIn(up, win);
          inkLines.push({ id, i, n: ge.lines.length, ratio: b ? b.coverage / Math.max(a.coverage, MIN_INK_PX) : null, at: gl, light: lumaOf(a.ink) > lumaOf(a.bg) });
          if (b) { const de = deltaE2000(a.ink, b.ink); if (!wDe || de > wDe.de) wDe = { de, i, a: a.ink, b: b.ink }; }
        });
        if (wDe) {
          const x = wDe as { de: number; i: number; a: number[]; b: number[] };
          row.ink = r6(x.de);
          if (x.de > limit + EPS) {
            issue(id, "ink", `line ${x.i + 1} of ${ge.lines.length}: text colour ΔE2000 ${x.de.toFixed(2)}, design ${hex(x.a)}, Unity ${hex(x.b)} (limit ${limit} at ${Number(px.toFixed(2))} px)`, ge.lines[x.i]);
          }
        }
      }

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

    // text ink amount: UI Toolkit draws thinner anti-aliased stems than the macOS golden, whose font smoothing thickens
    // light text more than dark text (Unity/design 0.69-1.03 for correct text, docs/findings/text-ink.md). A line's ratio
    // must lie between the measured ratio and identity (each with the tolerance), and, when the capture has 3 or more
    // measured lines of the same polarity, within the tolerance of their median ratio, which cancels the renderer and
    // leaves a wrong weight, size or glyph run
    const medianOf = (light: boolean) => {
      const ratios = inkLines.filter((l) => l.light === light).map((l) => l.ratio).filter((r): r is number => r !== null).sort((a, b) => a - b);
      return ratios.length >= 3 ? ratios[(ratios.length - 1) >> 1] / 2 + ratios[ratios.length >> 1] / 2 : null;
    };
    const medians = { light: medianOf(true), dark: medianOf(false) };
    const lo = t.textInkRatio * (1 - t.textInkCoverage), hi = 1 + t.textInkCoverage;
    const worstInk = new Map<string, { l: InkLine; score: number }>();
    for (const l of inkLines) {
      const median = l.light ? medians.light : medians.dark;
      const score = l.ratio === null ? Infinity : Math.max(lo - l.ratio, l.ratio - hi, median === null ? -Infinity : Math.abs(l.ratio / median - 1) - t.textInkMedianTolerance);
      const prev = worstInk.get(l.id);
      if (!prev || score > prev.score) worstInk.set(l.id, { l, score });
    }
    for (const [id, { l, score }] of worstInk) {
      rowOf.get(id)!.inkRatio = l.ratio === null ? 0 : r6(l.ratio);
      if (score <= EPS) continue;
      const head = `line ${l.i + 1} of ${l.n}`, tail = "weight, size or glyphs differ";
      if (l.ratio === null) issue(id, "inkCoverage", `${head}: no text ink in Unity`, l.at);
      else if (l.ratio < lo - EPS || l.ratio > hi + EPS) {
        issue(id, "inkCoverage", `${head}: Unity draws ${l.ratio.toFixed(2)}× the design's text ink (expected ${lo.toFixed(2)}–${hi.toFixed(2)}×): ${tail}`, l.at);
      } else {
        const median = (l.light ? medians.light : medians.dark)!;
        issue(id, "inkCoverage", `${head}: text ink ${l.ratio.toFixed(2)}× the design's, ${pct(l.ratio / median - 1)} against the median ${median.toFixed(2)}× of this capture's ${l.light ? "light" : "dark"} text (limit ±${Math.round(t.textInkMedianTolerance * 100)} %): ${tail}`, l.at);
      }
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
      worstElement: worst, maxBoxDelta: maxBox, maxDeltaE: maxDE, pixelsOff, linesNotCompared, notSampled, translucent, masked, elements: rows,
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
    const { verdict, heat } = analyze({ png: gpng, boxes: gb }, { png: upng, boxes: unityBoxes[name] }, removed!, t, ctx, !!opts.diffDir);
    verdict.info = entry ? {
      state: entry.state, viewport: entry.viewport, apply: entry.apply,
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
  const timings: Record<string, number> = {};
  if (isObj(exportReport) && isObj(exportReport.timings)) {
    if (typeof exportReport.timings.lint === "number") timings.lint = exportReport.timings.lint;
    if (typeof exportReport.totalMs === "number") timings.export = exportReport.totalMs;
  }
  Object.assign(timings, opts.timings ?? {});
  timings.compare = Math.round(performance.now() - t0);
  if (!names.length) notes.push("the export has no golden captures");
  return {
    screen, pass: names.length > 0 && notRun.length === 0 && captures.every((c) => c.pass),
    captures, notRun, notRunReasons, extra, thresholds: t, timings, platform, removed: [...removed!].sort(),
    animations: animationStrips(entries.filter((e) => known.has(e.name))), warnings, notes,
  };
}

const KIND_RANK: IssueKind[] = ["size", "missing", "extra", "visibility", "lines", "box", "baseline", "ssim", "edge", "color", "ink", "inkCoverage", "shadow"];

/** Short issue lines (`<capture>: <element>: <detail>`), most structural first, then (unless left out) not-run captures. */
export function summarizeIssues(v: ScreenVerdict, limit = 20, opts: { notRun?: boolean } = {}): string[] {
  const all = v.captures.flatMap((c) => c.issues.map((i) => ({ c: c.capture, i })));
  all.sort((a, b) => KIND_RANK.indexOf(a.i.kind) - KIND_RANK.indexOf(b.i.kind));
  const lines = all.map(({ c, i }) => `${c}: ${i.id === WHOLE ? "whole capture" : i.id}: ${i.detail}`);
  if (opts.notRun !== false) lines.push(...v.notRun.map((n) => `${n}: not run (${v.notRunReasons[n] ?? "no Unity capture"})`));
  return lines.slice(0, limit);
}
