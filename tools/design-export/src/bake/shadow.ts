/**
 * box-shadow bake (spec §7 step 5): Chromium draws the shadow alone — element transparent, page transparent, device
 * scale 1 — and the PNG it encodes is the asset, so the pixels are Chromium's own. Several shadows of one kind (outer or
 * inset) are drawn together into one image. An outer shadow is transparent under the border box (CSS clips it there;
 * for an opaque background Chromium clips 1px inside, and so does the bake).
 *
 * A probe render, large enough for every corner band to end, measures where columns and rows stop changing (the
 * insets keep one uniform texel inside each band, so bilinear sampling has no seam). The shadow is then drawn at the
 * smallest element size whose image is exactly the probe's 9-slice — Chromium blurs small boxes another way than large
 * ones — and each element size is checked once against Chromium's own rendering at that size: the shared 9-slice when it
 * is exact there (many sizes share one file), else the element's own bake (also for elements below the shared size). The image rect is the union of the shadow and the
 * border box for outer shadows, and the padding box for inset ones, so its offset does not depend on the size.
 *
 * One page per run, warm; renders are serialised on it and cached by their inputs, and the asset file is written once
 * per content hash.
 */
import type { Browser, Page } from "playwright";
import type { BoxRect, IrShadow } from "../ir/types.js";
import { LENGTH_RE, splitTopLevel } from "../lint/css-values.js";
import { expandBorderRadius, lengthPx } from "../lint/resolve/radius.js";
import { storeAsset } from "../extract/assets.js";
import { decodePng, opaqueBounds, sameColumn, sameRow, type Rgba } from "./png.js";

export type BakedShadow = IrShadow;
export interface ShadowOptions {
  /** The element's border box; omitted: large enough for the minimal 9-slice. */
  box?: { w: number; h: number };
  /** Border widths top, right, bottom, left (px): inset shadows are drawn inside them. */
  borders?: [number, number, number, number];
  /** The element's colour: shadows without a colour (or with currentcolor) use it. */
  color?: string;
  /**
   * The element's background colour is opaque: Chromium then clips an outer shadow 1px inside the border box (no
   * seam at the anti-aliased edge), so the bake does the same.
   */
  opaqueBackground?: boolean;
  /** Font sizes for em / rem lengths in the shadow. */
  fontSize?: number;
  rootFontSize?: number;
}

/** A box-shadow list split into outer and inset shadows (each in its own order); `none` is empty. */
export function splitShadows(value: string): { outer: string[]; inset: string[] } {
  const out = { outer: [] as string[], inset: [] as string[] };
  const v = value.trim();
  if (!v || /^none$/i.test(v)) return out;
  for (const item of splitTopLevel(v, ",")) {
    if (!item) continue;
    (splitTopLevel(item, " ").some((t) => t.toLowerCase() === "inset") ? out.inset : out.outer).push(item);
  }
  return out;
}

/** Why a box-shadow value cannot be baked (empty when it can be); bakeShadow throws the same text. Shared with lint U-CSS-014. */
export function shadowIssues(value: string, opts: Pick<ShadowOptions, "fontSize" | "rootFontSize"> = {}): string[] {
  const { outer, inset } = splitShadows(value);
  const out: string[] = [];
  for (const item of [...outer, ...inset]) { try { parseShadow(item, opts); } catch (e) { out.push((e as Error).message); } }
  return out;
}

interface Parsed { inset: boolean; ox: number; oy: number; blur: number; spread: number; colorless: boolean }
function parseShadow(item: string, o: Pick<ShadowOptions, "fontSize" | "rootFontSize">): Parsed {
  const toks = splitTopLevel(item, " ");
  const lens: number[] = [];
  let colorless = true, inset = false;
  for (const t of toks) {
    if (t.toLowerCase() === "inset") { inset = true; continue; }
    if (LENGTH_RE.test(t)) {
      const n = lengthPx(t, 0, { fontSize: o.fontSize ?? 16, rootFontSize: o.rootFontSize ?? 16 });
      if (n === null) throw new Error(`box-shadow length ${t} cannot be baked (use px)`);
      lens.push(n);
      continue;
    }
    if (!/^currentcolor$/i.test(t)) colorless = false;
  }
  if (lens.length < 2 || lens.length > 4) throw new Error(`box-shadow "${item}" is not a shadow`);
  return { inset, ox: lens[0], oy: lens[1], blur: Math.max(0, lens[2] ?? 0), spread: lens[3] ?? 0, colorless };
}

const BAKE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}` +
  `#bake{position:absolute;box-sizing:border-box;background:transparent;border-style:solid;border-color:transparent}</style></head>` +
  `<body><div id="bake"></div></body></html>`;

interface Spec { shadow: string; radius: string; borders: [number, number, number, number]; color: string; opaque: boolean; fontSize: number; rootFontSize: number }
interface Probe { slice: [number, number, number, number]; off: BoxRect; min: { w: number; h: number }; bytes: Buffer; size: [number, number]; pad: number }
interface Final { bytes: Buffer; w: number; h: number; slice: [number, number, number, number]; offset: BoxRect }

class PageBaker {
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private viewport = { width: 0, height: 0 };
  readonly probes = new Map<string, Promise<Probe | null>>();
  readonly finals = new Map<string, Promise<Final | null>>();
  constructor(readonly page: Page) {}

  private prepare(): Promise<void> {
    return (this.ready ??= (async () => {
      const dpr = await this.page.evaluate(() => window.devicePixelRatio);
      if (dpr !== 1) throw new Error(`the bake page must have device scale 1 (it has ${dpr}); use openBakePage`);
      await this.page.setContent(BAKE_HTML);
      const vp = this.page.viewportSize();
      this.viewport = { width: vp?.width ?? 0, height: vp?.height ?? 0 };
    })());
  }

  /** Draws the element at (pad, pad) with size w × h and returns Chromium's PNG of `clip` (serialised on the page). */
  render(spec: Spec, w: number, h: number, pad: number, clip: BoxRect): Promise<Buffer> {
    const job = this.queue.then(async () => {
      await this.prepare();
      const need = { width: Math.ceil(Math.max(clip.x + clip.w, pad * 2 + w)), height: Math.ceil(Math.max(clip.y + clip.h, pad * 2 + h)) };
      if (need.width > this.viewport.width || need.height > this.viewport.height) {
        this.viewport = { width: Math.max(need.width, this.viewport.width), height: Math.max(need.height, this.viewport.height) };
        await this.page.setViewportSize(this.viewport);
      }
      await this.page.evaluate((a) => {
        document.documentElement.style.fontSize = `${a.rootFontSize}px`;
        const el = document.getElementById("bake") as HTMLElement;
        // an opaque background colour painted into an empty content box: Chromium treats the box as opaque, nothing shows
        const opaque = a.opaque ? `background-color:#000000;background-clip:content-box;padding:${a.h / 2}px ${a.w / 2}px;` : "";
        el.style.cssText = `left:${a.pad}px;top:${a.pad}px;width:${a.w}px;height:${a.h}px;border-width:${a.borders.map((b) => `${b}px`).join(" ")};` +
          `border-radius:${a.radius};color:${a.color};font-size:${a.fontSize}px;box-shadow:${a.shadow};${opaque}`;
        void el.offsetWidth;
      }, { ...spec, w, h, pad });
      return this.page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h }, omitBackground: true, animations: "disabled", caret: "hide" });
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

const bakers = new WeakMap<Page, PageBaker>();
const bakerOf = (page: Page) => { let b = bakers.get(page); if (!b) { b = new PageBaker(page); bakers.set(page, b); } return b; };

/** A transparent page at device scale 1 for bakes; keep it for the whole run (renders are cached per page). */
export async function openBakePage(browser: Browser): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

const shared = new WeakMap<Browser, Promise<Page>>();
/** The bake page of a browser, opened on first use and kept until the browser closes: every screen of a run shares its cache. */
export function sharedBakePage(browser: Browser): Promise<Page> {
  let p = shared.get(browser);
  if (!p) {
    p = openBakePage(browser).then((b) => b.page);
    p.catch(() => shared.delete(browser));
    shared.set(browser, p);
  }
  return p;
}

/** First and last index of the run of columns (or rows) equal to `mid`, inside [lo, hi). */
function run(img: Rgba, mid: number, lo: number, hi: number, same: (img: Rgba, a: number, b: number) => boolean): [number, number] {
  let a = mid, b = mid;
  while (a - 1 >= lo && same(img, a - 1, mid)) a--;
  while (b + 1 < hi && same(img, b + 1, mid)) b++;
  return [a, b];
}

/** Crop of an image. */
function crop(img: Rgba, r: BoxRect): Rgba {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.w + r.x) * 4, ((r.y + y) * img.w + r.x + r.w) * 4), y * r.w * 4);
  return { w: r.w, h: r.h, data: out };
}

/** `a` is exactly the 9-slice (insets t, r, b, l) of `ref` drawn at a's size: corners and bands equal, centre uniform. */
function sameNineSlice(a: Rgba, ref: Rgba, [t, r, b, l]: number[]): boolean {
  const map = (d: number, size: number, lo: number, hi: number, src: number) => (d < lo ? d : d >= size - hi ? src - (size - d) : lo);
  for (let y = 0; y < a.h; y++) {
    const sy = map(y, a.h, t, b, ref.h);
    for (let x = 0; x < a.w; x++) {
      const sx = map(x, a.w, l, r, ref.w), o = (y * a.w + x) * 4, q = (sy * ref.w + sx) * 4;
      if (a.data[o] !== ref.data[q] || a.data[o + 1] !== ref.data[q + 1] || a.data[o + 2] !== ref.data[q + 2] || a.data[o + 3] !== ref.data[q + 3]) return false;
    }
  }
  return true;
}

/** Corner radii (px, horizontal and vertical) of a border-radius value; the sums an element side must hold unscaled. */
function radiusSums(value: string): { x: number; y: number } {
  const c = expandBorderRadius(value);
  if (!c) throw new Error(`border-radius "${value}" cannot be baked (px values)`);
  const r = Object.fromEntries(Object.entries(c).map(([k, v]) => {
    const [h, w = h] = splitTopLevel(v, " ");
    return [k, [lengthPx(h, 0) ?? 0, lengthPx(w, 0) ?? 0]];
  })) as Record<string, [number, number]>;
  return {
    x: Math.max(r["top-left"][0] + r["top-right"][0], r["bottom-left"][0] + r["bottom-right"][0]),
    y: Math.max(r["top-left"][1] + r["bottom-left"][1], r["top-right"][1] + r["bottom-right"][1]),
  };
}

/** The image rect of a render: the union of the drawn pixels and the border box (outer), or the padding box (inset). */
function imageRect(bb: BoxRect, pad: number, w: number, h: number, inset: boolean, [bt, br, bb2, bl]: number[]): BoxRect {
  if (inset) return { x: pad + bl, y: pad + bt, w: w - bl - br, h: h - bt - bb2 };
  const x0 = Math.min(bb.x, pad), y0 = Math.min(bb.y, pad);
  return { x: x0, y: y0, w: Math.max(bb.x + bb.w, pad + w) - x0, h: Math.max(bb.y + bb.h, pad + h) - y0 };
}

/** Insets of one axis: the band plus one uniform texel when the render has a uniform middle, else split in the middle. */
const insets = (run: [number, number], lo: number, size: number): [number, number] =>
  run[1] - run[0] >= 2 ? [run[0] - lo + 1, lo + size - 1 - run[1] + 1] : [Math.floor((size - 1) / 2), size - 1 - Math.floor((size - 1) / 2)];

/**
 * Bakes a box-shadow list of one kind (all outer or all inset; see splitShadows) for an element with these corner
 * radii (a border-radius value in px). Writes `<outDir>/assets/<sha256>.png` and returns its IR record, or null when the
 * shadow draws nothing. `offset` places the image relative to the element's border box (see IrShadow).
 */
export async function bakeShadow(page: Page, boxShadow: string, borderRadius: string, outDir: string, opts: ShadowOptions = {}): Promise<BakedShadow | null> {
  const items = splitTopLevel(boxShadow.trim(), ",").filter(Boolean);
  if (!items.length || /^none$/i.test(boxShadow.trim())) return null;
  const parsed = items.map((x) => parseShadow(x, opts));
  const inset = parsed[0].inset;
  if (parsed.some((p) => p.inset !== inset)) throw new Error(`box-shadow "${boxShadow}" mixes inset and outer shadows; bake them separately`);
  const em = /\d(r?em)\b/i.test(boxShadow);
  const spec: Spec = {
    shadow: items.join(", "), radius: borderRadius.trim() || "0px",
    borders: inset ? (opts.borders ?? [0, 0, 0, 0]).map((b) => Math.max(0, b)) as Spec["borders"] : [0, 0, 0, 0],
    color: parsed.some((p) => p.colorless) ? opts.color ?? "#000000" : "#000000", opaque: !inset && !!opts.opaqueBackground,
    fontSize: em ? opts.fontSize ?? 16 : 16, rootFontSize: em ? opts.rootFontSize ?? 16 : 16,
  };
  const baker = bakerOf(page);
  const key = JSON.stringify(spec);
  const radSum = radiusSums(spec.radius);
  const reach = Math.max(...parsed.map((p) => Math.max(Math.abs(p.ox), Math.abs(p.oy)) + Math.abs(p.spread) + Math.ceil(1.5 * p.blur) + 2));
  const border = Math.max(...spec.borders);

  /** Renders at w × h and measures the image rect and the uniform middle (null: nothing drawn). */
  const measure = async (w: number, h: number, pad0: number) => {
    for (let pad = pad0; ; pad *= 2) {
      const img = decodePng(await baker.render(spec, w, h, pad, { x: 0, y: 0, w: w + 2 * pad, h: h + 2 * pad }));
      const bb = opaqueBounds(img);
      if (!bb) return null;
      if ((bb.x === 0 || bb.y === 0 || bb.x + bb.w === img.w || bb.y + bb.h === img.h) && pad < 4096) continue;
      const rect = imageRect(bb, pad, w, h, inset, spec.borders);
      if (rect.w <= 0 || rect.h <= 0) return null;
      const cols = run(img, pad + Math.floor(w / 2), rect.x, rect.x + rect.w, sameColumn);
      const rows = run(img, pad + Math.floor(h / 2), rect.y, rect.y + rect.h, sameRow);
      return { img: crop(img, rect), pad, rect, off: { x: rect.x - pad, y: rect.y - pad, w: rect.w - w, h: rect.h - h }, cols, rows };
    }
  };

  // ---- probe (large enough for every band to end) and the smallest render that is the same 9-slice ----------------
  let probe = baker.probes.get(key);
  if (!probe) {
    probe = (async (): Promise<Probe | null> => {
      let size = 2 * (2 * reach + Math.max(radSum.x, radSum.y) + border) + 8;
      for (let attempt = 0; attempt < 6; attempt++, size *= 2) {
        const m = await measure(size, size, inset ? 2 : reach);
        if (!m) return null;
        if (m.cols[1] - m.cols[0] < 2 || m.rows[1] - m.rows[0] < 2) continue; // no uniform middle yet
        const [l, r] = insets(m.cols, m.rect.x, m.rect.w), [t, b] = insets(m.rows, m.rect.y, m.rect.h);
        const slice: Probe["slice"] = [t, r, b, l];
        // Chromium (Skia) blurs small boxes another way than large ones: grow the centre until the render is exactly
        // the probe's 9-slice (from a 48 px element, doubling); smaller elements are baked at their own size
        const at = (c: number) => ({ w: Math.max(l + c + r - m.off.w, radSum.x, 1), h: Math.max(t + c + b - m.off.h, radSum.y, 1) });
        const tryC = async (c: number) => {
          const { w, h } = at(c);
          const rect = { x: m.pad + m.off.x, y: m.pad + m.off.y, w: w + m.off.w, h: h + m.off.h };
          const bytes = await baker.render(spec, w, h, m.pad, rect);
          return sameNineSlice(decodePng(bytes), m.img, slice) ? { slice, off: m.off, min: { w, h }, bytes, size: [rect.w, rect.h] as [number, number], pad: m.pad } : null;
        };
        for (let c = Math.max(1, 48 - (l + r - m.off.w), 48 - (t + b - m.off.h)); ; c *= 2) {
          const { w, h } = at(c);
          if (w >= size && h >= size) return { slice, off: m.off, min: { w: size, h: size }, bytes: await baker.render(spec, size, size, m.pad, m.rect), size: [m.rect.w, m.rect.h], pad: m.pad };
          const found = await tryC(c);
          if (found) return found;
        }
      }
      throw new Error(`box-shadow "${boxShadow}" has no uniform middle even on a ${size}px element`);
    })();
    baker.probes.set(key, probe);
  }
  const p = await probe;
  if (!p) return null;

  // ---- each element size once: the shared 9-slice when Chromium draws exactly that at this size, else its own bake --
  const box = opts.box;
  const sharedFinal: Final = { bytes: p.bytes, w: p.size[0], h: p.size[1], slice: p.slice, offset: p.off };
  let f: Final | null = sharedFinal;
  if (box) {
    const w = Math.max(1, Math.round(box.w)), h = Math.max(1, Math.round(box.h));
    const fkey = `${key}\u0000${w}\u0000${h}`;
    let fin = baker.finals.get(fkey);
    if (!fin) {
      fin = (async (): Promise<Final | null> => {
        if (w >= p.min.w && h >= p.min.h) {
          const rect = { x: p.pad + p.off.x, y: p.pad + p.off.y, w: w + p.off.w, h: h + p.off.h };
          const here = decodePng(await baker.render(spec, w, h, p.pad, rect));
          if (sameNineSlice(here, decodePng(p.bytes), p.slice)) return sharedFinal;
        }
        const m = await measure(w, h, reach + 2);
        if (!m) return null;
        const [l, r] = insets(m.cols, m.rect.x, m.rect.w), [t, b] = insets(m.rows, m.rect.y, m.rect.h);
        return { bytes: await baker.render(spec, w, h, m.pad, m.rect), w: m.rect.w, h: m.rect.h, slice: [t, r, b, l], offset: m.off };
      })();
      baker.finals.set(fkey, fin);
    }
    f = await fin;
  }
  if (!f) return null;
  const { file, sha256 } = storeAsset(outDir, f.bytes, "png");
  return { kind: "shadow9", file, sha256, width: f.w, height: f.h, slice: [...f.slice], tint: false, stopGap: null, offset: { ...f.offset } };
}
