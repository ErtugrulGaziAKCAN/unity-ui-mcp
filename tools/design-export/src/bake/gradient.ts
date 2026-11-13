/**
 * CSS linear/radial gradients → SVG (spec §5.3, findings R8): the SVG importer turns it into a VectorImage background
 * (`SVGType.VectorImage`, 64-step ramp). The SVG is the element's border box in user space; each gradient is laid out
 * for the padding box (the CSS background positioning area) with the geometry and colour stops of CSS Images 3 as
 * Chromium resolves them (stop fix-up, sRGB colours), extended with `pad` beyond it. Several gradients become rects
 * painted in CSS order (the first on top).
 *
 * SVG interpolates colour and opacity separately; CSS interpolates premultiplied. Stops are rewritten so both agree: a
 * transparent stop takes its neighbour's colour (split in two when its neighbours differ), and a segment between two
 * different colours of different opacity gets intermediate stops on the premultiplied curve.
 */
import { splitTopLevel } from "../lint/css-values.js";
import { findGradients, linearAngle, radialCenter, resolveStopOffsets, type ParsedGradient } from "../lint/resolve/gradient.js";
import { lengthPx, type LengthContext } from "../lint/resolve/radius.js";
import { normalizeColor } from "../extract/styles.js";
import { fmt } from "../extract/naming.js";

export interface GradientOptions {
  /** Border widths top, right, bottom, left (px): the gradient is laid out for the padding box inside them. */
  borders?: [number, number, number, number];
  /** The element's colour, for currentcolor stops. */
  color?: string;
  fontSize?: number;
  rootFontSize?: number;
}

type Rgba = [number, number, number, number];
interface Stop { offset: number; color: Rgba }
interface Laid { kind: "linear" | "radial"; stops: Stop[]; attrs: string; gap: number | null }

/**
 * Problems that keep a background-image value from being baked (empty when it can be). Shared with lint U-CSS-014;
 * colour hints are U-CSS-022's and other image functions U-CSS-024's (the bake rejects them too).
 */
export function backgroundIssues(value: string): string[] {
  const v = value.trim();
  if (!v || /^none$/i.test(v)) return [];
  const items = splitTopLevel(v, ",").filter(Boolean);
  const out: string[] = [];
  const urls = items.filter((i) => /^url\(/i.test(i));
  if (urls.length && items.length > 1) out.push(`${items.length} background images with a url() among them (UI Toolkit draws one image)`);
  for (const item of items) {
    if (/^url\(/i.test(item)) continue;
    const name = /^([\w-]+)\(/.exec(item)?.[1].toLowerCase();
    if (name !== "linear-gradient" && name !== "radial-gradient") continue; // other functions are U-CSS-024's
    const g = findGradients(item)[0];
    if (!g || g.text.length !== item.length) { out.push(`${item.slice(0, 40)}: not one gradient`); continue; }
    for (const s of g.stops) if (!rgbaOf(s.color, "#000000")) out.push(`${g.type}-gradient colour "${s.color}" cannot be baked (sRGB colours and currentcolor only)`);
    if (g.stops.length < 2) out.push(`${g.type}-gradient needs two colour stops`);
  }
  return out;
}

/** `rgba` channels (0–255, alpha 0–1) of a CSS colour, or null when it is not one the bake supports. */
function rgbaOf(css: string, current: string): Rgba | null {
  const t = css.trim();
  const v = normalizeColor(/^currentcolor$/i.test(t) ? current : t);
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex) return [0, 2, 4].map((o) => parseInt(hex[1].slice(o, o + 2), 16)).concat(1) as Rgba;
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.e-]+)\)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

function gradientsOf(value: string): ParsedGradient[] {
  const issues = backgroundIssues(value);
  // colour hints are lint U-CSS-022's, other image functions U-CSS-024's
  for (const g of findGradients(value)) if (g.hints.length) issues.push(`colour hint ${g.hints.join(", ")} (SVG gradients have no hints)`);
  for (const item of splitTopLevel(value.trim(), ",")) {
    const name = /^([\w-]+)\(/.exec(item)?.[1].toLowerCase();
    if (name && name !== "url" && name !== "linear-gradient" && name !== "radial-gradient") issues.push(`${name}() cannot be baked (only linear-gradient() and radial-gradient())`);
  }
  const urls = splitTopLevel(value.trim(), ",").some((i) => /^url\(/i.test(i));
  if (urls && !issues.length) issues.push("url() images are not gradients");
  if (issues.length) throw new Error(`cannot bake background-image ${value.trim()}: ${issues.join("; ")}`);
  if (/^none$/i.test(value.trim())) return [];
  return splitTopLevel(value.trim(), ",").filter(Boolean).map((i) => findGradients(i)[0]);
}

const at = (a: Stop, b: Stop, t: number): Rgba => {
  // premultiplied interpolation (CSS Images 3 §3.5.1) of a and b at t ∈ [0, 1] of the way
  const alpha = a.color[3] + (b.color[3] - a.color[3]) * t;
  if (alpha <= 0) return [a.color[0], a.color[1], a.color[2], 0];
  const ch = (k: number) => (a.color[k] * a.color[3] * (1 - t) + b.color[k] * b.color[3] * t) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
};

/** Stops as SVG interpolates them (straight colour and opacity) giving CSS's premultiplied result. */
function svgStops(stops: Stop[]): Stop[] {
  const SAMPLES = 16;
  const out: Stop[] = [];
  const rgb = (c: Rgba, from: Rgba): Rgba => [from[0], from[1], from[2], c[3]];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s.color[3] > 0) { out.push(s); }
    else {
      // invisible: take the neighbours' colours (two stops at one offset when they differ)
      const prev = stops[i - 1], next = stops[i + 1];
      const inC = prev && prev.color[3] > 0 ? rgb(s.color, prev.color) : next && next.color[3] > 0 ? rgb(s.color, next.color) : s.color;
      const outC = next && next.color[3] > 0 ? rgb(s.color, next.color) : inC;
      out.push({ offset: s.offset, color: inC });
      if (outC.slice(0, 3).some((v, k) => v !== inC[k])) out.push({ offset: s.offset, color: outC });
    }
    const next = stops[i + 1];
    if (!next || next.offset <= s.offset) continue;
    const a = s, b = next;
    if (a.color[3] > 0 && b.color[3] > 0 && a.color[3] !== b.color[3] && a.color.slice(0, 3).some((v, k) => v !== b.color[k])) {
      for (let k = 1; k < SAMPLES; k++) out.push({ offset: a.offset + ((b.offset - a.offset) * k) / SAMPLES, color: at(a, b, k / SAMPLES) });
    }
  }
  return out;
}

function lay(g: ParsedGradient, w: number, h: number, o: GradientOptions): Laid {
  const [bt, br, bb, bl] = o.borders ?? [0, 0, 0, 0];
  const pw = Math.max(0, w - bl - br), ph = Math.max(0, h - bt - bb);
  const box = { w: pw, h: ph };
  const ctx: LengthContext = { fontSize: o.fontSize, rootFontSize: o.rootFontSize };
  const colors = g.stops.map((s) => rgbaOf(s.color, o.color ?? "#000000")!);
  if (g.type === "linear") {
    const a = linearAngle(g.prelude, box);
    if (a === null) throw new Error(`cannot bake ${g.text}: direction "${g.prelude}"`);
    const rad = (a * Math.PI) / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
    const len = Math.abs(pw * dx) + Math.abs(ph * dy);
    const offs = resolveStopOffsets(g, len, ctx);
    if (offs.some((x) => x === null)) throw new Error(`cannot bake ${g.text}: a stop position cannot be resolved`);
    const raw = offs.map((x, k) => ({ offset: x!, color: colors[k] }));
    const lo = Math.min(0, raw[0].offset), hi = Math.max(1, raw[raw.length - 1].offset);
    const cx = bl + pw / 2, cy = bt + ph / 2, sx = cx - (dx * len) / 2, sy = cy - (dy * len) / 2;
    const p = (t: number) => [sx + dx * len * t, sy + dy * len * t];
    const [x1, y1] = p(lo), [x2, y2] = p(hi);
    const stops = raw.map((s) => ({ offset: hi > lo ? (s.offset - lo) / (hi - lo) : 0, color: s.color }));
    return { kind: "linear", stops, attrs: `x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"`, gap: gapOf(raw) };
  }
  // radial: centre, then the ending shape's radii (CSS Images 3 §3.2.1)
  const c = radialCenter(g.prelude, box, ctx);
  if (!c) throw new Error(`cannot bake ${g.text}: position "${g.prelude}"`);
  const pre = (g.prelude ?? "").replace(/\bat\b.*$/i, "").trim().toLowerCase();
  const toks = pre ? splitTopLevel(pre, " ") : [];
  const lens = toks.filter((t) => /\d/.test(t));
  const circle = toks.includes("circle") || (!toks.includes("ellipse") && lens.length === 1);
  const dxs = [Math.abs(c.x), Math.abs(pw - c.x)], dys = [Math.abs(c.y), Math.abs(ph - c.y)];
  const size = toks.find((t) => /^(closest|farthest)-(side|corner)$/.test(t)) ?? "farthest-corner";
  const near = size.startsWith("closest");
  const sx = near ? Math.min(...dxs) : Math.max(...dxs), sy = near ? Math.min(...dys) : Math.max(...dys);
  let rx: number, ry: number;
  if (circle) {
    if (lens.length) rx = lengthPx(lens[0], pw, ctx) ?? NaN;
    else if (size.endsWith("side")) rx = near ? Math.min(sx, sy) : Math.max(sx, sy);
    else { const corners = dxs.flatMap((x) => dys.map((y) => Math.hypot(x, y))); rx = near ? Math.min(...corners) : Math.max(...corners); }
    ry = rx;
  } else if (lens.length === 2) {
    rx = lengthPx(lens[0], pw, ctx) ?? NaN; ry = lengthPx(lens[1], ph, ctx) ?? NaN;
  } else if (size.endsWith("side")) { rx = sx; ry = sy; }
  else { rx = sx * Math.SQRT2; ry = sy * Math.SQRT2; }
  if (!(rx > 0) || !(ry > 0)) throw new Error(`cannot bake ${g.text}: its ending shape is degenerate (radii ${rx} × ${ry})`);
  const offs = resolveStopOffsets(g, rx, ctx);
  if (offs.some((x) => x === null)) throw new Error(`cannot bake ${g.text}: a stop position cannot be resolved`);
  let raw = offs.map((x, k) => ({ offset: x!, color: colors[k] }));
  const gap = gapOf(raw);
  // a negative stop: the colour at 0 is interpolated (CSS), the gradient starts there
  if (raw[0].offset < 0) {
    const k = raw.findIndex((s) => s.offset >= 0);
    if (k < 0) raw = [{ offset: 0, color: raw[raw.length - 1].color }];
    else {
      const a = raw[k - 1], b = raw[k];
      raw = [{ offset: 0, color: at(a, b, (0 - a.offset) / (b.offset - a.offset)) }, ...raw.slice(k)];
    }
  }
  const hi = Math.max(1, raw[raw.length - 1].offset);
  const stops = raw.map((s) => ({ offset: s.offset / hi, color: s.color }));
  const cx = bl + c.x, cy = bt + c.y, r = rx * hi;
  const tf = Math.abs(ry - rx) > 1e-9 ? ` gradientTransform="translate(${fmt(cx)} ${fmt(cy)}) scale(1 ${fmt(ry / rx)}) translate(${fmt(-cx)} ${fmt(-cy)})"` : "";
  return { kind: "radial", stops, attrs: `cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"${tf}`, gap };
}

/** Smallest offset distance between consecutive stops whose (premultiplied) colours differ; null when none differ. */
function gapOf(stops: Stop[]): number | null {
  let gap: number | null = null;
  const same = (a: Rgba, b: Rgba) => (a[3] === 0 && b[3] === 0) || a.every((v, k) => v === b[k]);
  for (let i = 0; i + 1 < stops.length; i++) {
    if (same(stops[i].color, stops[i + 1].color)) continue;
    const d = stops[i + 1].offset - stops[i].offset;
    if (gap === null || d < gap) gap = d;
  }
  return gap;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const stopXml = (s: Stop) => {
  const a = Math.max(0, Math.min(1, s.color[3]));
  return `<stop offset="${fmt(Math.max(0, Math.min(1, s.offset)))}" stop-color="#${s.color.slice(0, 3).map(hex2).join("")}"${a < 1 ? ` stop-opacity="${fmt(a)}"` : ""}/>`;
};

/**
 * The SVG of a background-image made of CSS linear/radial gradients (one, or a comma list), for an element whose border
 * box is width × height px. Deterministic text; throws on anything the bake cannot reproduce (see backgroundIssues).
 */
export function gradientToSvg(value: string, width: number, height: number, opts: GradientOptions = {}): string {
  const laid = gradientsOf(value).map((g) => lay(g, width, height, opts));
  const W = fmt(width), H = fmt(height);
  const defs = laid.map((l, k) => `<${l.kind}Gradient id="g${k}" gradientUnits="userSpaceOnUse" ${l.attrs}>${svgStops(l.stops).map(stopXml).join("")}</${l.kind}Gradient>`);
  const rects = laid.map((_, k) => `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#g${k})"/>`).reverse();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join("")}</defs>${rects.join("")}</svg>`;
}

/** Smallest stop spacing of the gradients of a background-image (fraction of each gradient line), see IrAsset.stopGap. */
export function gradientStopGap(value: string, width: number, height: number, opts: GradientOptions = {}): number | null {
  let gap: number | null = null;
  for (const g of gradientsOf(value)) {
    const x = lay(g, width, height, opts).gap;
    if (x !== null && (gap === null || x < gap)) gap = x;
  }
  return gap;
}
