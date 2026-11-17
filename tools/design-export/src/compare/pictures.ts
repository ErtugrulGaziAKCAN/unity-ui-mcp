/**
 * The pictures a report keeps once the captures are gone (spec §15): for each failing capture, a thumbnail of the design,
 * the Unity capture and the difference image, and a full-resolution crop of each of the first issues that has a place.
 * The design-ui server writes them next to the screen's bookkeeping and then deletes the Unity captures and difference
 * images of the run; passing captures keep no pictures (the goldens stay in the export).
 */
import fs from "node:fs";
import path from "node:path";
import type { Rgba } from "../bake/png.js";
import { captureFiles, type CaptureVerdict, type ScreenVerdict } from "./compare.js";
import { decodePngAsync, encodePngAsync } from "./png.js";
import type { Rect } from "./ssim.js";

/** Thumbnails are at most this wide (device px of the picture). */
export const THUMB_WIDTH = 960;
/** Crops per failing capture, and their largest size. */
export const MAX_CROPS = 6;
/**
 * Failing captures that keep thumbnails: the first of each set of issues (element and check), up to this many. A screen's
 * state matrix often fails the same way in hundreds of captures (a pilot's 918 failing captures kept 175 MB of
 * thumbnails); a later capture with the same issues points at the first one's pictures.
 */
export const MAX_THUMB_CAPTURES = 24;
/** Issue crops written per report: one per element, check and viewport, reused by the later captures that share it. */
export const MAX_CROP_SETS = 200;
const CROP_MAX: [number, number] = [640, 400];
const CROP_MARGIN = 16;

/** An issue's crop; `from`: the capture whose pictures it is, when an earlier capture with the same issue made it. */
export interface CropSet { detail: string; design: string; unity: string; diff: string | null; from?: string }
/**
 * A failing capture's pictures: thumbnails (null when it keeps none: `like` names the earlier capture with the same issues
 * whose thumbnails show them, else the thumbnail cap was reached) and its issues' crops.
 */
export interface CapturePictures {
  design: string | null; unity: string | null; diff: string | null; crops: CropSet[]; like?: string;
  /** Issues with a place that got no crop because the report's crop limit was reached. */
  cropsSkipped?: number;
}

/** The limits of a report's pictures (tests lower them). */
export interface PictureLimits { maxThumbCaptures?: number; maxCropSets?: number }
/** Pictures by capture name; file paths are absolute. */
export type ReportPictures = Map<string, CapturePictures>;

/** A box-filtered copy at most `width` px wide (the same picture when it is narrower). */
export function downscale(img: Rgba, width: number): Rgba {
  if (img.w <= width) return img;
  const f = img.w / width, h = Math.max(1, Math.round(img.h / f));
  const out = new Uint8Array(width * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * f), sy1 = Math.min(img.h, Math.max(sy0 + 1, Math.floor((y + 1) * f)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * f), sx1 = Math.min(img.w, Math.max(sx0 + 1, Math.floor((x + 1) * f)));
      const acc = [0, 0, 0, 0];
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * img.w + sx) * 4;
        for (let k = 0; k < 4; k++) acc[k] += img.data[o + k];
      }
      const n = (sy1 - sy0) * (sx1 - sx0), o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / n);
    }
  }
  return { w: width, h, data: out };
}

/** A part of a picture (clamped to it). */
export function crop(img: Rgba, r: Rect): Rgba {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.w, Math.ceil(r.x + r.w)), y1 = Math.min(img.h, Math.ceil(r.y + r.h));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h && y0 + y < img.h; y++) out.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, data: out };
}

/** The crop window of an issue: its place with a margin, at most CROP_MAX (its top-left part beyond that). */
function window(at: Rect): Rect {
  return { x: at.x - CROP_MARGIN, y: at.y - CROP_MARGIN, w: Math.min(at.w + 2 * CROP_MARGIN, CROP_MAX[0]), h: Math.min(at.h + 2 * CROP_MARGIN, CROP_MAX[1]) };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Writes the pictures of the failing captures of `v` into `outDir` (`<index>-design.png`, `-unity.png`, `-diff.png`,
 * `<index>-<k>-design.png` …) from the goldens in `exportDir`, the Unity captures in `unityDir` and the difference images
 * the comparison wrote; returns them by capture. Bounded: thumbnails for the first failing capture of each set of issues
 * (at most {@link MAX_THUMB_CAPTURES}), one crop per element, check and viewport (at most {@link MAX_CROP_SETS}, at most
 * {@link MAX_CROPS} per capture), which later captures with the same issue reuse.
 */
export async function writeReportPictures(v: ScreenVerdict, exportDir: string, unityDir: string, outDir: string, limits: PictureLimits = {}): Promise<ReportPictures> {
  const maxThumbs = limits.maxThumbCaptures ?? MAX_THUMB_CAPTURES, maxCrops = limits.maxCropSets ?? MAX_CROP_SETS;
  const pictures: ReportPictures = new Map();
  const failing = v.captures.map((c, i) => [c, i] as const).filter(([c]) => !c.pass);
  if (!failing.length) return pictures;
  fs.mkdirSync(outDir, { recursive: true });
  const fileOf = captureFiles(exportDir);
  const write = async (name: string, img: Rgba) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, await encodePngAsync(img));
    return file;
  };
  const read = async (file: string | null) => (file && fs.existsSync(file) ? decodePngAsync(fs.readFileSync(file)) : null);
  const thumbsOf = new Map<string, string>(); // issue set -> the capture that keeps its thumbnails
  const cropsOf = new Map<string, CropSet & { capture: string }>(); // element, check and viewport -> its crop
  let thumbs = 0;
  for (const [c, i] of failing) {
    const signature = Array.from(new Set(c.issues.map((x) => `${x.id}\u0000${x.kind}`))).sort().join("\u0001");
    const like = thumbsOf.get(signature);
    const wantThumbs = like === undefined && thumbs < maxThumbs;
    const cropKey = (x: { id: string; kind: string }) => `${x.id}\u0000${x.kind}\u0000${c.size[0]}x${c.size[1]}`;
    const newCrops = c.issues.some((x) => x.at && !cropsOf.has(cropKey(x))) && cropsOf.size < maxCrops;
    let design: Rgba | null = null, unity: Rgba | null = null, diff: Rgba | null = null;
    if (wantThumbs || newCrops) {
      [design, unity, diff] = await Promise.all([
        read(path.join(exportDir, "goldens", `${fileOf(c.capture)}.png`)), read(path.join(unityDir, `${fileOf(c.capture)}.png`)), read(c.diff ?? null),
      ]);
      if (!design || !unity) continue;
    }
    const thumb = (img: Rgba) => downscale(img, Math.min(THUMB_WIDTH, img.w));
    const set: CapturePictures = { design: null, unity: null, diff: null, crops: [], ...(like !== undefined ? { like } : {}) };
    if (wantThumbs && design && unity) {
      set.design = await write(`${i}-design.png`, thumb(design));
      set.unity = await write(`${i}-unity.png`, thumb(unity));
      set.diff = diff ? await write(`${i}-diff.png`, thumb(diff)) : null;
      thumbsOf.set(signature, c.capture);
      thumbs++;
    }
    const windows: Rect[] = [];
    for (const issue of c.issues) {
      if (!issue.at || set.crops.length >= MAX_CROPS) continue;
      const detail = `${issue.id === "*" ? "whole capture" : issue.id}: ${issue.detail}`;
      const known = cropsOf.get(cropKey(issue));
      if (known) {
        if (!set.crops.some((x) => x.design === known.design)) set.crops.push({ detail, design: known.design, unity: known.unity, diff: known.diff, from: known.capture });
        continue;
      }
      if (cropsOf.size >= maxCrops) { set.cropsSkipped = (set.cropsSkipped ?? 0) + 1; continue; }
      if (!design || !unity) continue;
      const w = window(issue.at);
      if (windows.some((x) => overlaps(x, issue.at!) && x.x <= issue.at!.x && x.y <= issue.at!.y && x.x + x.w >= issue.at!.x + issue.at!.w && x.y + x.h >= issue.at!.y + issue.at!.h)) continue;
      windows.push(w);
      const k = set.crops.length;
      const made: CropSet = {
        detail,
        design: await write(`${i}-${k}-design.png`, crop(design, w)),
        unity: await write(`${i}-${k}-unity.png`, crop(unity, w)),
        diff: diff ? await write(`${i}-${k}-diff.png`, crop(diff, w)) : null,
      };
      cropsOf.set(cropKey(issue), { ...made, capture: c.capture });
      set.crops.push(made);
    }
    pictures.set(c.capture, set);
  }
  return pictures;
}

/** Whether a capture keeps pictures (a failing one does). */
export const keepsPictures = (c: CaptureVerdict) => !c.pass;
