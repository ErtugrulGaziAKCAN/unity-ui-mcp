/**
 * Fidelity comparison of Unity captures against the design's goldens (spec §11, §15): this decides "one to one".
 *
 * Per capture (static, pseudo-state and animation sample alike, with the same thresholds):
 * - every golden element: present in Unity (unless the compiler removed it as a wrapper without boxes), the same
 *   visibility (hidden on both sides: nothing else is compared; hidden on one side: a visibility issue, never a box
 *   delta), border box within ±`boxPx`, text with the same line count and every line's baseline within ±`baselinePx`
 *   (elements whose design text is not in DOM text, i.e. inputs and selects, report no lines: not compared);
 * - copy-mask SSIM (ssim.ts): whole capture ≥ `ssimNonText`; each visible non-text element ≥ 16×16 px ≥ `ssimElement`
 *   over its golden box joined with its active baked-shadow rect;
 * - colour: elements that paint a background, a 5×3 grid of 3×3-pixel means inside both boxes (inset 6 px; a single
 *   centre sample for elements under 16 px), skipping points near later-painted elements or masked pixels;
 *   ΔE2000 ≤ `deltaE2000`;
 * - shadow band: the mean colour of each active outer shadow's band (shadow rect minus element box), ΔE2000 ≤
 *   `deltaE2000`, so a faint missing shadow fails although SSIM dilutes it.
 * Masks (union of both sides, inflated by 2 px): before SSIM, the boxes of text elements and `data-u-external` regions
 * are copied from the golden (the pinned definition the SSIM thresholds were calibrated with), so text elements are
 * judged by their boxes, lines and baselines; colour samples skip only the text lines and external regions, so an
 * element that carries its own text (a button, a badge) still has its background sampled. Line widths are not compared (findings §4: the caret route's line rects differ from Chromium's by more than
 * a pixel at the same break), so a changed break with the same line count shows only through boxes and baselines.
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
import { blockSsimMap, maskRects, regionSsim, unionRect, wholeSsim, type Rect } from "./ssim.js";

export type { CaptureContext } from "./context.js";

export interface Thresholds { boxPx: number; baselinePx: number; deltaE2000: number; ssimNonText: number; ssimElement: number }

/** `tools/design-export/fidelity-thresholds.json`, the only place the thresholds live. */
export const THRESHOLDS_FILE = fileURLToPath(new URL("../../fidelity-thresholds.json", import.meta.url));
const THRESHOLD_KEYS: (keyof Thresholds)[] = ["boxPx", "baselinePx", "deltaE2000", "ssimNonText", "ssimElement"];

export function readThresholds(file: string = THRESHOLDS_FILE): Thresholds {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of THRESHOLD_KEYS) if (typeof raw[k] !== "number" || !Number.isFinite(raw[k])) throw new Error(`${file}: "${k}" must be a number`);
  return Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, raw[k] as number])) as unknown as Thresholds;
}

export type IssueKind = "box" | "missing" | "visibility" | "lines" | "baseline" | "color" | "ssim" | "shadow" | "size";
/** Element id of capture-level issues (whole-capture SSIM, image size). */
export const WHOLE = "*";

export interface ElementIssue {
  id: string;
  kind: IssueKind;
  detail: string;
  /** Where (golden device px): the element box, its SSIM region or the colour sample; absent for capture-level issues. */
  at?: Rect;
}

/** One golden element of a capture: what was compared and the measured values (null: not compared). */
export interface ElementRow {
  id: string;
  status: "ok" | "fail" | "hidden" | "removed" | "missing";
  /** Unity minus design: x, y, w, h in device px. */
  box: [number, number, number, number] | null;
  ssim: number | null;
  deltaE: number | null;
  /** Shadow band ΔE2000. */
  band: number | null;
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
  worstElement: { id: string; ssim: number } | null;
  maxBoxDelta: { id: string; px: number } | null;
  maxDeltaE: { id: string; deltaE: number } | null;
  /** Share of unmasked pixels with a channel off by more than 3 (null when not compared). */
  pixelsOff: number | null;
  /** Text elements whose lines are not compared (their design text is not DOM text: inputs, selects). */
  linesNotCompared: string[];
  /** Regions copied from the design before SSIM and skipped by colour samples (text, external; inflated by 2 px). */
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
  /** What the comparison could not use (e.g. no IR: no shadow bands). */
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
const FX = [0.1, 0.3, 0.5, 0.7, 0.9], FY = [0.25, 0.5, 0.75];
const fmt = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

type Box = CaptureBoxes["elements"][string];
interface Side { png: Rgba; boxes: CaptureBoxes }

/**
 * Text regions of one side, visible elements only: `box` gives each text element's border box (the pinned SSIM
 * copy-mask); `lines` each text line's rect, or the box when the element reports no lines (colour samples).
 */
function textRegions(boxes: CaptureBoxes, what: "box" | "lines"): Rect[] {
  const out: Rect[] = [];
  for (const e of Object.values(boxes.elements)) {
    if (!e.text || !e.visible) continue;
    if (what === "lines" && e.lines.length) out.push(...e.lines);
    else out.push(e);
  }
  return out;
}

/** Mean RGB over a window of up to 3×3 pixels around (x, y), clamped to `clip`; b's masked pixels come from a. */
function sample(img: Rgba, x: number, y: number, clip: Rect, from?: { a: Rgba; mask: Uint8Array }): [number, number, number] {
  const x0 = Math.max(0, Math.ceil(clip.x), x - 1), x1 = Math.min(img.w - 1, Math.ceil(clip.x + clip.w) - 1, x + 1);
  const y0 = Math.max(0, Math.ceil(clip.y), y - 1), y1 = Math.min(img.h - 1, Math.ceil(clip.y + clip.h) - 1, y + 1);
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const p = yy * img.w + xx, src = from && from.mask[p] ? from.a.data : img.data, o = p * 4;
    r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
  }
  if (!n) { const p = (Math.min(img.h - 1, Math.max(0, y)) * img.w + Math.min(img.w - 1, Math.max(0, x))) * 4; return [img.data[p], img.data[p + 1], img.data[p + 2]]; }
  return [r / n, g / n, b / n];
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
  const g = golden.boxes, u = unity.boxes, gp = golden.png, up = unity.png;
  const issues: ElementIssue[] = [];
  const rows: ElementRow[] = [];
  const linesNotCompared: string[] = [];
  const removedSet = new Set(removed);
  const issue = (id: string, kind: IssueKind, detail: string, at?: Rect) => issues.push(at ? { id, kind, detail, at } : { id, kind, detail });

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
    const row: ElementRow = { id, status: "ok", box: null, ssim: null, deltaE: null, band: null, lines: null };
    rows.push(row);
    rowOf.set(id, row);
    if (!ue) {
      if (removedSet.has(id)) { row.status = "removed"; continue; }
      row.status = "missing";
      issue(id, "missing", "in the design, but not in the Unity capture", ge);
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

  // ---- masks (both sides, inflated by 2 px): SSIM copies text element boxes and external regions from the design (the
  // pinned definition its thresholds were calibrated with); colour samples skip only text lines and external regions,
  // so an element that carries text (a button, a badge) still has its own background sampled
  const w = gp.w, h = gp.h;
  let ssim: number | null = null, pixelsOff: number | null = null, heat: Rgba | null = null, masked: Rect[] = [];
  let worst: { id: string; ssim: number } | null = null, maxDE: { id: string; deltaE: number } | null = null;
  if (sameSize) {
    const externalBoxes = [...g.external.map((id) => g.elements[id]), ...u.external.map((id) => u.elements[id])].filter((e): e is Box => !!e);
    const regions = [...textRegions(g, "box"), ...textRegions(u, "box"), ...externalBoxes];
    const mask = maskRects(w, h, regions, 2);
    const colourMask = maskRects(w, h, [...textRegions(g, "lines"), ...textRegions(u, "lines"), ...externalBoxes], 2);
    masked = regions.filter((r) => r.w > 0 && r.h > 0).map((r) => ({ x: r6(r.x - 2), y: r6(r.y - 2), w: r6(r.w + 4), h: r6(r.h + 4) }));
    const external = new Set([...g.external, ...u.external]);
    const fullViewport = (e: Box) => e.x <= 0 && e.y <= 0 && e.x + e.w >= w && e.y + e.h >= h;

    const map = blockSsimMap(gp, up, mask);
    ssim = wholeSsim(map);
    if (ssim < t.ssimNonText - EPS) issue(WHOLE, "ssim", `whole-capture SSIM ${ssim.toFixed(5)} (limit ${t.ssimNonText})`);

    const from = { a: gp, mask };
    const paintIndex = new Map(order.map((id, i) => [id, i]));
    const later = (id: string): Rect[] => {
      const ge = g.elements[id];
      if (paintIndex.has(id)) {
        return order.slice(paintIndex.get(id)! + 1).map((x) => g.elements[x]).filter((e): e is Box => !!e && e.visible);
      }
      // without the IR: elements drawn inside this one (smaller boxes it contains)
      return Object.entries(g.elements).filter(([x, e]) => x !== id && e.visible && e.w * e.h < ge.w * ge.h
        && e.x >= ge.x && e.y >= ge.y && e.x + e.w <= ge.x + ge.w && e.y + e.h <= ge.y + ge.h).map(([, e]) => e);
    };

    for (const id of compared) {
      const ge = g.elements[id], ue = u.elements[id], row = rowOf.get(id)!;
      if (external.has(id)) continue;
      const shadow = ctx.shadows?.[id];

      // element SSIM over box ∪ shadow rect: non-text elements (a text element's box is copied from the design)
      if (!ge.text && ge.w >= MIN_ELEMENT && ge.h >= MIN_ELEMENT && id !== ctx.root && !fullViewport(ge)) {
        const region = shadow ? unionRect(ge, shadow) : ge;
        const s = regionSsim(map, region);
        if (!Number.isNaN(s)) {
          row.ssim = r6(s);
          if (!worst || s < worst.ssim) worst = { id, ssim: r6(s) };
          if (s < t.ssimElement - EPS) issue(id, "ssim", `element SSIM ${s.toFixed(5)} over the ${shadow ? "box and baked shadow" : "box"} (limit ${t.ssimElement})`, region);
        }
      }

      // colour samples
      if (!ctx.backgrounds || ctx.backgrounds.has(id)) {
        const ix0 = Math.max(ge.x, ue.x), iy0 = Math.max(ge.y, ue.y), ix1 = Math.min(ge.x + ge.w, ue.x + ue.w), iy1 = Math.min(ge.y + ge.h, ue.y + ue.h);
        const small = ix1 - ix0 < MIN_ELEMENT || iy1 - iy0 < MIN_ELEMENT;
        const clip = { x: ix0, y: iy0, w: Math.max(0, ix1 - ix0), h: Math.max(0, iy1 - iy0) };
        if (clip.w > 0 && clip.h > 0) {
          const pts: [number, number][] = small
            ? [[Math.floor(ix0 + clip.w / 2), Math.floor(iy0 + clip.h / 2)]]
            : FY.flatMap((fy) => FX.map((fx) => [Math.floor(ix0 + 6 + (clip.w - 12) * fx), Math.floor(iy0 + 6 + (clip.h - 12) * fy)] as [number, number]));
          const covering = later(id);
          let best: { de: number; x: number; y: number; a: number[]; b: number[] } | null = null;
          for (const [x, y] of pts) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (covering.some((l) => inside(l, x, y, 2))) continue;
            let touchesMask = false;
            for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !touchesMask; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (colourMask[yy * w + xx]) { touchesMask = true; break; }
            if (touchesMask) continue;
            const a = sample(gp, x, y, clip), b = sample(up, x, y, clip);
            const de = deltaE2000(a, b);
            if (!best || de > best.de) best = { de, x, y, a, b };
          }
          if (best) {
            row.deltaE = r6(best.de);
            if (!maxDE || best.de > maxDE.deltaE) maxDE = { id, deltaE: r6(best.de) };
            if (best.de > t.deltaE2000 + EPS) {
              issue(id, "color", `ΔE2000 ${best.de.toFixed(2)} at (${best.x}, ${best.y}): design ${hex(best.a)}, Unity ${hex(best.b)} (limit ${t.deltaE2000})`,
                { x: best.x - 1, y: best.y - 1, w: 3, h: 3 });
            }
          }
        }
      }

      // shadow band
      if (shadow) {
        const a = bandMean(gp, shadow, ge), b = bandMean(up, shadow, ge, from);
        if (a && b) {
          const de = deltaE2000(a, b);
          row.band = r6(de);
          if (de > t.deltaE2000 + EPS) issue(id, "shadow", `shadow band ΔE2000 ${de.toFixed(2)}: design ${hex(a)}, Unity ${hex(b)} (limit ${t.deltaE2000})`, shadow);
        }
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
      worstElement: worst, maxBoxDelta: maxBox, maxDeltaE: maxDE, pixelsOff, linesNotCompared, masked, elements: rows,
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
export async function compareScreen(exportDir: string, unityDir: string, t: Thresholds, opts: CompareOptions = {}): Promise<ScreenVerdict> {
  const t0 = performance.now();
  const goldensDir = path.join(exportDir, "goldens");
  const goldenBoxesFile = path.join(goldensDir, "boxes.json");
  if (!fs.existsSync(goldenBoxesFile)) throw new Error(`${exportDir} is not a design export (no goldens/boxes.json)`);
  const goldenBoxes = readBoxesFile(goldenBoxesFile, "design");
  const notes: string[] = [];

  const matrix = tryJson(path.join(goldensDir, "matrix.json"));
  const entries: MatrixEntry[] = isObj(matrix) && Array.isArray(matrix.captures) ? (matrix.captures as MatrixEntry[]) : [];
  if (!entries.length) notes.push("goldens/matrix.json not found: captures in name order, no animation strips");
  const byName = new Map(entries.map((e) => [e.name, e]));
  const names = entries.length
    ? [...entries.map((e) => e.name).filter((n) => n in goldenBoxes), ...Object.keys(goldenBoxes).filter((n) => !byName.has(n)).sort()]
    : Object.keys(goldenBoxes).sort();
  const platform = isObj(matrix) && typeof matrix.chromium === "string" ? { chromium: matrix.chromium, platform: String(matrix.platform ?? "") } : null;

  let ix: IrIndex | null = null;
  const irFile = path.join(exportDir, "screen.ir.json");
  if (fs.existsSync(irFile)) {
    try { ix = indexIr(readJson(irFile)); } catch (e) { notes.push(`screen.ir.json could not be read (${(e as Error).message}): no shadow bands, paint order or background filter`); }
  } else notes.push("screen.ir.json not found: no shadow bands, paint order or background filter");

  const exportReport = tryJson(path.join(exportDir, "export-report.json"));
  const screen = ix?.screen || (isObj(exportReport) && typeof exportReport.screen === "string" ? exportReport.screen : "") || path.basename(path.resolve(exportDir));

  let removed = opts.removed;
  if (!removed) {
    const manifest = tryJson(path.join(unityDir, ".design-ui.json"));
    removed = isObj(manifest) && Array.isArray(manifest.removedElements) ? manifest.removedElements.filter((x): x is string => typeof x === "string") : [];
  }

  const unityBoxesFile = path.join(unityDir, "boxes.json");
  const unityBoxes = fs.existsSync(unityBoxesFile) ? readBoxesFile(unityBoxesFile, "Unity") : {};
  const notRunReasons: Record<string, string> = {};
  const runnable: string[] = [];
  for (const name of names) {
    if (!fs.existsSync(path.join(goldensDir, `${name}.png`))) notRunReasons[name] = "the design capture PNG is missing from the export";
    else if (!fs.existsSync(path.join(unityDir, `${name}.png`))) notRunReasons[name] = "no Unity capture PNG";
    else if (!unityBoxes[name]) notRunReasons[name] = "no entry in the Unity boxes.json";
    else runnable.push(name);
  }
  const known = new Set(names);
  const unityPngs = fs.existsSync(unityDir) ? fs.readdirSync(unityDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : [];
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
    animations: animationStrips(entries.filter((e) => known.has(e.name))), notes,
  };
}

const KIND_RANK: IssueKind[] = ["size", "missing", "visibility", "lines", "box", "baseline", "ssim", "color", "shadow"];

/** Short issue lines (`<capture>: <element>: <detail>`), most structural first, then (unless left out) not-run captures. */
export function summarizeIssues(v: ScreenVerdict, limit = 20, opts: { notRun?: boolean } = {}): string[] {
  const all = v.captures.flatMap((c) => c.issues.map((i) => ({ c: c.capture, i })));
  all.sort((a, b) => KIND_RANK.indexOf(a.i.kind) - KIND_RANK.indexOf(b.i.kind));
  const lines = all.map(({ c, i }) => `${c}: ${i.id === WHOLE ? "whole capture" : i.id}: ${i.detail}`);
  if (opts.notRun !== false) lines.push(...v.notRun.map((n) => `${n}: not run (${v.notRunReasons[n] ?? "no Unity capture"})`));
  return lines.slice(0, limit);
}
