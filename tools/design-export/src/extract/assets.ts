import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import type { IrAsset } from "../ir/types.js";
import type { KitConfig } from "../kit.js";
import type { SnapDecl } from "../lint/css-values.js";
import type { Breakpoint } from "../lint/resolve/media.js";
import { DESIGN_ORIGIN, KIT_PREFIX, type LoadedDesign } from "../load.js";
import { physicalNames, type DomSnapshot, type Size } from "../lint/snapshot.js";
import { dimKind, dimsOf } from "./layers.js";
import type { ChildSeq } from "./text.js";

/** SVG presentation properties written as computed values into a serialised inline SVG (currentColor and page CSS resolved). */
export const SVG_PAINT = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stop-color", "stop-opacity", "flood-color",
  "flood-opacity", "lighting-color", "clip-rule", "paint-order", "vector-effect"];
/** Also written on SVG content (not on the <svg> root, whose opacity and visibility are the node's own style). */
const SVG_CONTENT_ONLY = ["opacity", "visibility"];

export interface PageRequest {
  seqs: number[];
  /** Elements whose rendered text (innerText) is needed; hidden ones are read again in each screen state. */
  texts: number[];
  /** Inline SVGs to serialise; `tint`: shapes painted with currentColor are written white. */
  svgs: { i: number; tint: boolean }[];
  imgs: number[];
  bgUrls: string[];
  root: number;
  states: string[];
}
export interface PageData {
  seqs: Map<number, ChildSeq>;
  rendered: Map<number, string | null>;
  svgs: Map<number, string>;
  imgs: Map<number, { src: string; w: number; h: number }>;
  bgs: Map<string, { w: number; h: number }>;
}

interface PageArg extends PageRequest { paint: string[]; contentOnly: string[] }
interface PageOut {
  seqs: [number, ChildSeq][]; rendered: [number, string | null][]; svgs: [number, string][]; imgs: [number, { src: string; w: number; h: number }][];
  bgs: [string, { w: number; h: number } | null][];
}

/** Runs in the page (one call): child order, rendered text, serialised SVGs, image sources and sizes. Leaves the page as it was. */
async function pageExtract(arg: PageArg): Promise<PageOut> {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const idx = new Map<Element, number>(els.map((e, i) => [e, i]));
  const seqs: PageOut["seqs"] = arg.seqs.map((i) => [i, Array.from(els[i].childNodes).flatMap((n): ChildSeq =>
    n.nodeType === 3 ? [{ t: (n as Text).data }] : n.nodeType === 1 && idx.has(n as Element) ? [{ e: idx.get(n as Element)! }] : [])]);
  const rendered = new Map<number, string | null>(arg.texts.map((i) => [i, els[i].getClientRects().length ? (els[i] as HTMLElement).innerText : null]));
  const root = els[arg.root];
  if (Array.from(rendered.values()).some((v) => v === null)) {
    for (const st of arg.states) {
      const cls = `state-${st}`;
      const had = root.classList.contains(cls);
      root.classList.add(cls);
      for (const [i, v] of rendered) if (v === null && els[i].getClientRects().length) rendered.set(i, (els[i] as HTMLElement).innerText);
      if (!had) root.classList.remove(cls);
    }
  }
  const svgs: PageOut["svgs"] = arg.svgs.map(({ i, tint }) => {
    const src = els[i];
    const saved = src.getAttribute("style");
    if (tint) (src as SVGElement).style.setProperty("color", "#ffffff", "important");
    const clone = src.cloneNode(true) as Element;
    const from = [src, ...Array.from(src.querySelectorAll("*"))];
    const to = [clone, ...Array.from(clone.querySelectorAll("*"))];
    from.forEach((o, k) => {
      const c = to[k];
      const cs = getComputedStyle(o);
      for (const a of Array.from(c.attributes)) {
        const n = a.name.toLowerCase();
        if (n === "class" || n.startsWith("data-") || n === "color" || arg.paint.includes(n) || (k > 0 && arg.contentOnly.includes(n)) || (k === 0 && n === "style")) c.removeAttribute(a.name);
      }
      const st = (c as SVGElement).style;
      for (const p of k === 0 ? arg.paint : [...arg.paint, ...arg.contentOnly]) st.setProperty(p, cs.getPropertyValue(p));
      if (k > 0 && cs.display === "none") st.setProperty("display", "none");
    });
    if (tint) { src.getAttribute("style"); if (saved === null) src.removeAttribute("style"); else src.setAttribute("style", saved); }
    return [i, new XMLSerializer().serializeToString(clone)];
  });
  const imgs: PageOut["imgs"] = arg.imgs.map((i) => {
    const im = els[i] as HTMLImageElement;
    return [i, { src: im.currentSrc || im.src, w: im.naturalWidth, h: im.naturalHeight }];
  });
  const bgs: PageOut["bgs"] = await Promise.all(arg.bgUrls.map((u) => new Promise<[string, { w: number; h: number } | null]>((resolve) => {
    const im = new Image();
    im.onload = () => resolve([u, { w: im.naturalWidth, h: im.naturalHeight }]);
    im.onerror = () => resolve([u, null]);
    im.src = u;
  })));
  return { seqs, rendered: Array.from(rendered), svgs, imgs, bgs };
}

export async function collectPageData(page: Page, req: PageRequest): Promise<PageData> {
  const r = await page.evaluate(pageExtract as unknown as (a: PageArg) => Promise<PageOut>, { ...req, paint: SVG_PAINT, contentOnly: SVG_CONTENT_ONLY });
  const bgs = new Map<string, { w: number; h: number }>();
  for (const [u, sz] of r.bgs) if (sz) bgs.set(u, sz);
  return { seqs: new Map(r.seqs), rendered: new Map(r.rendered), svgs: new Map(r.svgs), imgs: new Map(r.imgs), bgs };
}

/** Runs in the page: untransformed border-box sizes (null when not rendered). */
function pageSizes(indices: number[]): (Size | null)[] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const num = (v: string) => parseFloat(v) || 0;
  return indices.map((i) => {
    const el = els[i];
    if (el.getClientRects().length === 0) return null;
    const cs = getComputedStyle(el);
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || cs.display === "inline") { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; }
    const extra = cs.boxSizing === "content-box"
      ? [num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth), num(cs.paddingTop) + num(cs.paddingBottom) + num(cs.borderTopWidth) + num(cs.borderBottomWidth)]
      : [0, 0];
    return { w: w + extra[0], h: h + extra[1] };
  });
}

type Mutation = { classes: [number, string][]; props: [number, "disabled" | "checked", boolean][] };
/** Runs in the page: adds classes and sets disabled/checked; returns what to undo (only what changed). */
function pageApply(m: Mutation): Mutation {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const undo: Mutation = { classes: [], props: [] };
  for (const [i, c] of m.classes) if (!els[i].classList.contains(c)) { els[i].classList.add(c); undo.classes.push([i, c]); }
  for (const [i, p, v] of m.props) {
    const el = els[i] as HTMLInputElement;
    if (p in el && el[p] !== v) { undo.props.push([i, p, el[p]]); el[p] = v; }
  }
  return undo;
}
/** Runs in the page: classes and properties applied, one size measured, everything reverted. */
function pageMeasureWith(arg: { m: Mutation; i: number }): Size | null {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const added: [Element, string][] = [];
  const props: [HTMLInputElement, "disabled" | "checked", boolean][] = [];
  for (const [k, c] of arg.m.classes) if (!els[k].classList.contains(c)) { els[k].classList.add(c); added.push([els[k], c]); }
  for (const [k, p, v] of arg.m.props) { const el = els[k] as HTMLInputElement; if (p in el && el[p] !== v) { props.push([el, p, el[p]]); el[p] = v; } }
  const el = els[arg.i];
  let size: Size | null = null;
  if (el.getClientRects().length) {
    const cs = getComputedStyle(el);
    const num = (v: string) => parseFloat(v) || 0;
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || cs.display === "inline") { const b = el.getBoundingClientRect(); size = { w: b.width, h: b.height }; }
    else {
      const extra = cs.boxSizing === "content-box"
        ? [num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth), num(cs.paddingTop) + num(cs.paddingBottom) + num(cs.borderTopWidth) + num(cs.borderBottomWidth)]
        : [0, 0];
      size = { w: w + extra[0], h: h + extra[1] };
    }
  }
  for (const [x, c] of added) x.classList.remove(c);
  for (const [x, p, v] of props) x[p] = v;
  return size;
}

/** Runs in the page: reverts pageApply. */
function pageUndo(u: Mutation): void {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  for (const [i, c] of u.classes) els[i].classList.remove(c);
  for (const [i, p, v] of u.props) (els[i] as HTMLInputElement)[p] = v;
}

/**
 * Element sizes with a layer applied: breakpoints by resizing the viewport into their range, the screen state
 * class on the root, is-* classes, hover/active/focus forced through CDP and disabled/checked as properties (own or
 * on the named ancestor). Everything is undone afterwards, the viewport included.
 */
export async function measureLayerBoxes(d: LoadedDesign, s: DomSnapshot, root: number, requests: Map<string, number[]>,
  indexOfId: Map<string, number>, breakpoints: ReadonlyMap<string, Breakpoint>): Promise<Map<string, Map<number, Size>>> {
  const out = new Map<string, Map<number, Size>>();
  if (!requests.size) return out;
  const page = d.page;
  const original = page.viewportSize();
  const ev = <A, R>(fn: (a: A) => R, a: A) => page.evaluate(fn as unknown as (x: unknown) => R, a as unknown) as Promise<R>;
  const forced = async (i: number, states: string[]) => {
    try { await d.cdp.send("CSS.forcePseudoState", { nodeId: s.elements[i].nodeId, forcedPseudoClasses: states }); }
    catch { await d.cdp.send("CSS.enable"); await d.cdp.send("CSS.forcePseudoState", { nodeId: s.elements[i].nodeId, forcedPseudoClasses: states }); }
  };
  try {
    for (const [key, els] of Array.from(requests).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const dims = dimsOf(key);
      // breakpoints: a viewport inside every range
      if (original) {
        let w = original.width, h = original.height;
        for (const dm of dims.filter((x) => dimKind(x) === "bp")) {
          const bp = breakpoints.get(dm.slice(3));
          if (!bp) continue;
          if (bp.minWidth !== undefined) w = Math.max(w, Math.ceil(bp.minWidth));
          if (bp.maxWidth !== undefined) w = Math.min(w, Math.floor(bp.maxWidth));
          if (bp.minAspect !== undefined && w / h < bp.minAspect) h = Math.floor(w / bp.minAspect);
          if (bp.maxAspect !== undefined && w / h > bp.maxAspect) h = Math.ceil(w / bp.maxAspect);
        }
        const cur = page.viewportSize();
        if (!cur || cur.width !== w || cur.height !== h) await page.setViewportSize({ width: w, height: h });
      }
      const global: Mutation = { classes: dims.filter((x) => dimKind(x) === "state").map((x) => [root, `state-${x.slice(6)}`]), props: [] };
      const undoGlobal = await ev(pageApply, global);
      const sizes = new Map<number, Size>();
      const perElement = dims.some((x) => dimKind(x) !== "state" && dimKind(x) !== "bp");
      if (!perElement) {
        // states and breakpoints apply to the whole screen: one measurement for every element of the layer
        const got = await ev(pageSizes, els);
        els.forEach((i, n) => { if (got[n]) sizes.set(i, got[n]!); });
      }
      for (const i of perElement ? els : []) {
        const m: Mutation = { classes: [], props: [] };
        const pseudo = new Map<number, string[]>();
        const apply = (target: number, what: string) => {
          if (what.startsWith("class:")) m.classes.push([target, what.slice(6)]);
          else if (what === "disabled" || what === "checked") m.props.push([target, what, true]);
          else pseudo.set(target, [...(pseudo.get(target) ?? []), what]);
        };
        let ok = true;
        for (const dm of dims) {
          const k = dimKind(dm);
          if (k === "class" || k === "pseudo") apply(i, dm);
          else if (k === "anc") {
            const mm = /^anc\(([^)]+)\):(.+)$/.exec(dm)!;
            const a = indexOfId.get(mm[1]);
            if (a === undefined) { ok = false; break; }
            apply(a, mm[2]);
          }
        }
        if (!ok) continue;
        let size: Size | null;
        if (!pseudo.size) size = await ev(pageMeasureWith, { m, i });
        else {
          const undo = await ev(pageApply, m);
          for (const [t, st] of pseudo) await forced(t, st);
          [size] = await ev(pageSizes, [i]);
          for (const [t] of pseudo) await forced(t, []);
          await ev(pageUndo, undo);
        }
        if (size) sizes.set(i, size);
      }
      await ev(pageUndo, undoGlobal);
      out.set(key, sizes);
    }
  } finally {
    if (original) {
      const cur = page.viewportSize();
      if (!cur || cur.width !== original.width || cur.height !== original.height) await page.setViewportSize(original);
    }
  }
  return out;
}

/** Attributes that may carry presentational styles on the whitelisted elements (CDP attributesStyle). */
const PRESENTATIONAL = ["hidden", "width", "height", "align", "valign", "border", "hspace", "vspace", "bgcolor", "color", "nowrap"];
export const hasPresentational = (attrs: Record<string, string>) => PRESENTATIONAL.some((a) => attrs[a] !== undefined);

/** Presentational attribute styles of the given elements (CDP attributesStyle), as physical longhand declarations. */
export async function presentationalStyles(cdp: CDPSession, s: DomSnapshot, indices: number[]): Promise<Map<number, SnapDecl[]>> {
  const out = new Map<number, SnapDecl[]>();
  if (!indices.length) return out;
  type Props = { name: string; value: string }[];
  const read = async (i: number): Promise<Props> => {
    const e = s.elements[i];
    try {
      const r = await cdp.send("CSS.getInlineStylesForNode", { nodeId: e.nodeId });
      return (r.attributesStyle?.cssProperties ?? []) as Props;
    } catch {
      // node ids from another DOM.getDocument: resolve through the stable backend id
      const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [e.backendNodeId] });
      const r = await cdp.send("CSS.getInlineStylesForNode", { nodeId: nodeIds[0] });
      return (r.attributesStyle?.cssProperties ?? []) as Props;
    }
  };
  const all = await Promise.all(indices.map(read));
  indices.forEach((i, k) => {
    const decls: SnapDecl[] = [];
    for (const p of all[k]) for (const n of physicalNames(p.name)) decls.push({ name: n, value: p.value, important: false });
    if (decls.length) out.set(i, decls);
  });
  return out;
}

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Writes `assets/<sha256>.<ext>` under outDir (once) and returns its IR record. */
export function writeAsset(outDir: string, bytes: Buffer, ext: string, kind: "image" | "svg", width: number, height: number, tint = false): IrAsset {
  const hash = sha(bytes);
  const file = `assets/${hash}.${ext}`;
  const target = path.join(outDir, file);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return { kind, file, sha256: hash, width: Math.max(width, 1), height: Math.max(height, 1), slice: null, tint };
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** Bytes and extension behind an image URL of the design page: the design folder, the kit, or a data: URL. */
export function readImageUrl(url: string, designDir: string, kit: KitConfig): { bytes: Buffer; ext: string } {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!m || !MIME_EXT[m[1]]) throw new Error(`unsupported data URL image (${url.slice(0, 40)}…)`);
    return { bytes: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8"), ext: MIME_EXT[m[1]] };
  }
  const u = new URL(url);
  if (u.origin !== DESIGN_ORIGIN) throw new Error(`image ${url} is not a local design file`);
  const rel = decodeURIComponent(u.pathname);
  const [root, sub] = rel.startsWith(KIT_PREFIX) ? [kit.dir, rel.slice(KIT_PREFIX.length)] : [designDir, rel.slice(1)];
  const file = path.resolve(root, "." + path.posix.normalize("/" + sub));
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`image ${url} is outside the design folder`);
  if (!fs.existsSync(file)) throw new Error(`image ${url} not found (${path.relative(designDir, file)})`);
  return { bytes: fs.readFileSync(file), ext: path.extname(file).slice(1).toLowerCase() || "bin" };
}

/** Intrinsic size of a serialised SVG: width/height attributes, else the viewBox, else the rendered box. */
export function svgSize(xml: string, fallback: Size | null): { w: number; h: number } {
  const root = /<svg\b[^>]*>/i.exec(xml)?.[0] ?? "";
  const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`, "i").exec(root)?.[1];
  const len = (v: string | undefined) => { const m = v && /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(v); return m ? Number(m[1]) : null; };
  const w = len(attr("width")), h = len(attr("height"));
  if (w && h) return { w, h };
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  return { w: fallback?.w ?? 1, h: fallback?.h ?? 1 };
}

/** First url(...) of a computed background-image. */
export function backgroundUrl(computed: string | undefined): string | null {
  const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(computed ?? "");
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : null;
}

export const fileSha = (file: string) => sha(fs.readFileSync(file));
