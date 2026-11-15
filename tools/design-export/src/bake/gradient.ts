/**
 * CSS linear/radial gradients → SVG (spec §5.3, findings R8): the SVG importer turns it into a VectorImage background
 * (`SVGType.VectorImage`, 64-step ramp). The SVG is the element's border box in user space; each gradient is laid out
 * for the padding box (the CSS background positioning area) with the geometry and colour stops of CSS Images 3 as
 * Chromium resolves them (stop fix-up, sRGB colours, a degenerate radial shape as its last colour) and repeated into the border area per
 * `background-repeat`, as CSS paints it. Several gradients are painted in CSS order (the first on top).
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
  /** `background-repeat` (a list for several gradients): how the image repeats into the border area. Default repeat. */
  repeat?: string;
  /**
   * Resolved corner radii in px (top-left, top-right, bottom-right, bottom-left; circular, U-CSS-020): the image is cut to
   * the rounded border box, as CSS clips a background. UI Toolkit draws a vector background image unclipped by the
   * element's border-radius, and its anti-aliased tessellation ignores SVG clip paths, so the painted shapes themselves
   * are rounded (docs/findings/filters.md, gradients).
   */
  radii?: [number, number, number, number];
}

/**
 * A painted rect (x0, y0)–(x1, y1) of a w × h border box as SVG: a `<rect>`, or a path whose corners that lie on a rounded
 * corner of the box are arcs. A rect that reaches into a corner's r × r square without covering it stays a rect (only
 * repeated gradient tiles smaller than the radius do that).
 */
function shape(x0: number, y0: number, x1: number, y1: number, w: number, h: number, radii: [number, number, number, number] | undefined, fill: string): string {
  const [tl, tr, br, bl] = radii ?? [0, 0, 0, 0];
  const on = (r: number, cx: boolean, cy: boolean) => r > 0 && cx && cy && x1 - x0 >= r && y1 - y0 >= r;
  const TL = on(tl, x0 <= 0, y0 <= 0) ? tl : 0, TR = on(tr, x1 >= w, y0 <= 0) ? tr : 0;
  const BR = on(br, x1 >= w, y1 >= h) ? br : 0, BL = on(bl, x0 <= 0, y1 >= h) ? bl : 0;
  if (!TL && !TR && !BR && !BL) return `<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(x1 - x0)}" height="${fmt(y1 - y0)}" fill="${fill}"/>`;
  const arc = (r: number, x: number, y: number) => (r > 0 ? `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y)}` : "");
  const d = `M${fmt(x0 + TL)} ${fmt(y0)}H${fmt(x1 - TR)}${arc(TR, x1, y0 + TR)}V${fmt(y1 - BR)}${arc(BR, x1 - BR, y1)}` +
    `H${fmt(x0 + BL)}${arc(BL, x0, y1 - BL)}V${fmt(y0 + TL)}${arc(TL, x0 + TL, y0)}Z`;
  return `<path d="${d}" fill="${fill}"/>`;
}

type Rgba = [number, number, number, number];
interface Stop { offset: number; color: Rgba }
/** One painted part of a gradient: a rect relative to the padding box and the gradient over it, placed at (ox, oy). */
interface Piece {
  kind: "linear" | "radial"; rect: { x: number; y: number; w: number; h: number }; stops: Stop[]; attrs: (ox: number, oy: number) => string;
  /**
   * A radial gradient that ends transparent: the ellipse (relative to the padding box) beyond which it paints nothing. Drawn
   * as that ellipse instead of the rect when it lies inside the painted shape, so the gradient is never sampled past its end
   * (Unity's VectorImage draws a speckled ring where a radial gradient's pad region starts: docs/findings/viewport-classes.md,
   * "The toggle switch's knob").
   */
  ends?: { cx: number; cy: number; rx: number; ry: number; stops: Stop[]; attrs: (ox: number, oy: number) => string };
}
/** `gap`: smallest stop spacing as a fraction of the SVG gradient vector (the importer's ramp). */
interface Laid { pieces: Piece[]; gap: number | null }

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

/** The value has colour hints or image functions other than linear/radial gradients and url() (lint U-CSS-022 / U-CSS-024 report them). */
export function reportedElsewhere(value: string): boolean {
  if (findGradients(value).some((g) => g.hints.length)) return true;
  return splitTopLevel(value.trim(), ",").some((item) => { const n = /^([\w-]+)\(/.exec(item)?.[1].toLowerCase(); return !!n && n !== "url" && n !== "linear-gradient" && n !== "radial-gradient"; });
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
  const full = { x: 0, y: 0, w: pw, h: ph };
  const ctx: LengthContext = { fontSize: o.fontSize, rootFontSize: o.rootFontSize };
  const colors = g.stops.map((s) => rgbaOf(s.color, o.color ?? "#000000")!);
  const resolve = (len: number) => {
    const offs = resolveStopOffsets(g, len, ctx);
    if (offs.some((x) => x === null)) throw new Error(`cannot bake ${g.text}: a stop position cannot be resolved`);
    return offs.map((x, k) => ({ offset: x!, color: colors[k] }));
  };
  if (g.type === "linear") {
    const a = linearAngle(g.prelude, box);
    if (a === null) throw new Error(`cannot bake ${g.text}: direction "${g.prelude}"`);
    const rad = (a * Math.PI) / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
    const len = Math.abs(pw * dx) + Math.abs(ph * dy);
    const raw = resolve(len);
    const lo = Math.min(0, raw[0].offset), hi = Math.max(1, raw[raw.length - 1].offset);
    const sx = pw / 2 - (dx * len) / 2, sy = ph / 2 - (dy * len) / 2;
    const p = (t: number) => [sx + dx * len * t, sy + dy * len * t];
    const [x1, y1] = p(lo), [x2, y2] = p(hi);
    const stops = raw.map((s) => ({ offset: hi > lo ? (s.offset - lo) / (hi - lo) : 0, color: s.color }));
    const attrs = (ox: number, oy: number) => `x1="${fmt(ox + x1)}" y1="${fmt(oy + y1)}" x2="${fmt(ox + x2)}" y2="${fmt(oy + y2)}"`;
    const gap = gapOf(raw);
    return { pieces: [{ kind: "linear", rect: full, stops, attrs }], gap: gap === null ? null : gap / (hi - lo) };
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
  if (!(rx >= 0) || !(ry >= 0)) throw new Error(`cannot bake ${g.text}: its ending shape cannot be resolved`);
  // a degenerate shape (a zero radius: centre on an edge with closest-side, or an explicit 0) — Chromium paints the last colour
  if (rx === 0 || ry === 0) {
    const last = colors[colors.length - 1];
    return { pieces: [{ kind: "linear", rect: full, stops: [{ offset: 0, color: last }, { offset: 1, color: last }], attrs: (ox, oy) => `x1="${fmt(ox)}" y1="${fmt(oy)}" x2="${fmt(ox + 1)}" y2="${fmt(oy)}"` }], gap: null };
  }
  let raw = resolve(rx);
  const gap0 = gapOf(raw);
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
  const r = rx * hi, gap = gap0 === null ? null : gap0 / hi;
  const attrs = (ox: number, oy: number) => {
    const cx = ox + c.x, cy = oy + c.y;
    const tf = Math.abs(ry - rx) > 1e-9 ? ` gradientTransform="translate(${fmt(cx)} ${fmt(cy)}) scale(1 ${fmt(ry / rx)}) translate(${fmt(-cx)} ${fmt(-cy)})"` : "";
    return `cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"${tf}`;
  };
  // a gradient that ends transparent paints nothing past its last stop: the ellipse there, drawn with the gradient's end
  // moved out a hair when the last stop is at it, so no point of the ellipse samples the gradient at or past its end
  const last = stops[stops.length - 1];
  let ends: Piece["ends"];
  if (last.color[3] === 0 && stops.length > 1) {
    const k = last.offset * 1.02 < 1 ? 1 : 1.02;
    const rr = r * k, er = r * last.offset * (k === 1 ? 1.02 : 1.01);
    ends = {
      cx: c.x, cy: c.y, rx: er, ry: (er * ry) / rx, stops: stops.map((st) => ({ offset: st.offset / k, color: st.color })),
      attrs: (ox, oy) => attrs(ox, oy).replace(/ r="[^"]*"/, ` r="${fmt(rr)}"`),
    };
  }
  return { pieces: [{ kind: "radial", rect: full, stops, attrs, ends }], gap };
}

/** Whether every point of an ellipse lies inside a rect with rounded corners (radii top-left, top-right, bottom-right, bottom-left). */
function ellipseInside(e: { cx: number; cy: number; rx: number; ry: number }, x0: number, y0: number, x1: number, y1: number, radii?: [number, number, number, number]): boolean {
  const [tl, tr, br, bl] = radii ?? [0, 0, 0, 0];
  const inside = (x: number, y: number) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const corner = (r: number, ax: number, ay: number, sx: number, sy: number) =>
      r > 0 && sx * (x - ax) > 0 && sy * (y - ay) > 0 ? Math.hypot(x - ax, y - ay) <= r : true;
    return corner(tl, x0 + tl, y0 + tl, -1, -1) && corner(tr, x1 - tr, y0 + tr, 1, -1) && corner(br, x1 - br, y1 - br, 1, 1) && corner(bl, x0 + bl, y1 - bl, -1, 1);
  };
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * 2 * Math.PI;
    if (!inside(e.cx + e.rx * Math.cos(a), e.cy + e.ry * Math.sin(a))) return false;
  }
  return true;
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
 * Whether the image repeats into the border area horizontally and vertically, for one `background-repeat` value. The
 * image fills the positioning area, so `round` repeats like `repeat` and `space` (one image fits) draws it once.
 */
function repeatAxes(v: string): [boolean, boolean] {
  const t = splitTopLevel(v.trim().toLowerCase(), " ");
  const on = (k: string) => k === "repeat" || k === "round";
  if (t.length === 2) return [on(t[0]), on(t[1])];
  if (t[0] === "repeat-x") return [true, false];
  if (t[0] === "repeat-y") return [false, true];
  return [on(t[0]), on(t[0])];
}

/**
 * The SVG of a background-image made of CSS linear/radial gradients (one, or a comma list), for an element whose border
 * box is width × height px. As CSS paints it: each gradient is the padding box's image, repeated per `background-repeat`
 * into the border area (the background is painted under the border); rects are cut to the border box. Deterministic text;
 * throws on anything the bake cannot reproduce (see backgroundIssues).
 */
export function gradientToSvg(value: string, width: number, height: number, opts: GradientOptions = {}): string {
  const [bt, br, bb, bl] = opts.borders ?? [0, 0, 0, 0];
  const pw = width - bl - br, ph = height - bt - bb;
  const repeats = splitTopLevel(opts.repeat?.trim() || "repeat", ",");
  const tiles = (on: boolean, before: number, after: number, size: number) => {
    if (!on || size <= 0) return [0];
    const out: number[] = [];
    for (let k = -Math.ceil(before / size); k <= Math.ceil(after / size); k++) out.push(k);
    return out;
  };
  const defs: string[] = [], layers: string[][] = [];
  let covered = false, partial = false;
  gradientsOf(value).forEach((g, k) => {
    const laid = lay(g, width, height, opts);
    const [rx, ry] = repeatAxes(repeats[k % repeats.length]);
    const rects: string[] = [];
    let n = 0;
    for (const ty of tiles(ry, bt, bb, ph)) for (const tx of tiles(rx, bl, br, pw)) for (const piece of laid.pieces) {
      const ox = bl + tx * pw, oy = bt + ty * ph;
      const x0 = Math.max(0, ox + piece.rect.x), y0 = Math.max(0, oy + piece.rect.y);
      const x1 = Math.min(width, ox + piece.rect.x + piece.rect.w), y1 = Math.min(height, oy + piece.rect.y + piece.rect.h);
      if (x1 <= x0 || y1 <= y0) continue;
      const id = n === 0 ? `g${k}` : `g${k}_${n}`;
      n++;
      const e = piece.ends && { cx: ox + piece.ends.cx, cy: oy + piece.ends.cy, rx: piece.ends.rx, ry: piece.ends.ry };
      if (e && ellipseInside(e, x0, y0, x1, y1, x0 <= 0 && y0 <= 0 && x1 >= width && y1 >= height ? opts.radii : undefined)) {
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ${piece.ends!.attrs(ox, oy)}>${svgStops(piece.ends!.stops).map(stopXml).join("")}</radialGradient>`);
        rects.push(`<ellipse cx="${fmt(e.cx)}" cy="${fmt(e.cy)}" rx="${fmt(e.rx)}" ry="${fmt(e.ry)}" fill="url(#${id})"/>`);
        partial = true;
      } else {
        defs.push(`<${piece.kind}Gradient id="${id}" gradientUnits="userSpaceOnUse" ${piece.attrs(ox, oy)}>${svgStops(piece.stops).map(stopXml).join("")}</${piece.kind}Gradient>`);
        rects.push(shape(x0, y0, x1, y1, width, height, opts.radii, `url(#${id})`));
      }
    }
    if (pw > 0 && ph > 0 && (rx || (bl <= 0 && br <= 0)) && (ry || (bt <= 0 && bb <= 0))) covered = true;
    layers.push(rects);
  });
  const W = fmt(width), H = fmt(height);
  // an image that leaves part of the box empty keeps the box as its bounds (the importer sizes a VectorImage by its geometry)
  const pin = covered && !partial ? "" : `<rect x="0" y="0" width="${W}" height="${H}" fill="#000000" fill-opacity="0"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join("")}</defs>${pin}${layers.reverse().flat().join("")}</svg>`;
}

/** Smallest stop spacing of the gradients of a background-image (fraction of each SVG gradient vector), see IrAsset.stopGap. */
export function gradientStopGap(value: string, width: number, height: number, opts: GradientOptions = {}): number | null {
  let gap: number | null = null;
  for (const g of gradientsOf(value)) {
    const x = lay(g, width, height, opts).gap;
    if (x !== null && (gap === null || x < gap)) gap = x;
  }
  return gap;
}
