import { transitionsAt } from "../../extract/anims.js";
import { layoutOf } from "../layout.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { Collector, at, declsAt, inSvg, isExternal, nonDesign, resolved, sources, targetOf } from "./util.js";

const FIX = "Give the element and its children the colours they show at that opacity instead: for disabled or dimmed controls " +
  "the kit's -disabled colour tokens (--color-disabled-surface, --color-disabled-line, --color-disabled-text, " +
  "--color-disabled-accent, …; each is its colour at 40 % over the screen background). Keep opacity, and fades of it, only on " +
  "an element that paints one thing (a background, a border, a text or an image) and has no painted children; let a panel or " +
  "dialog appear by a transform (translate, scale) or a colour change instead of a fade. CSS fades the element and its " +
  "children as one composited group, UI Toolkit fades each painted part on its own, so overlapping parts (a background under " +
  "a border, text or a child) show through each other in Unity, in every frame of a fade between 0 and 1.";

interface Rect { x0: number; y0: number; x1: number; y1: number }
/** A painted part: `outer` minus `inner` (a ring) or all of `outer`. */
interface Part { what: string; outer: Rect; inner: Rect | null }

const alpha = (c: string | undefined): number => {
  const v = (c ?? "").trim().toLowerCase();
  if (!v || v === "transparent") return 0;
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!m) return 1;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return Number.isFinite(a) ? a : 1;
};
const num = (v: string | undefined) => { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : 0; };
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const within = (a: Rect, b: Rect) => a.x0 >= b.x0 - 1e-6 && a.y0 >= b.y0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y1 <= b.y1 + 1e-6;
const EPS = 1e-3;

/** Whether two painted parts share pixels (a ring overlaps what reaches outside its inner rect). */
function overlap(a: Part, b: Part): boolean {
  const m = meet(a.outer, b.outer);
  if (area(m) <= EPS) return false;
  if (a.inner && within(m, a.inner)) return false;
  if (b.inner && within(m, b.inner)) return false;
  return true;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** A short name for messages: `#<data-u-id>`, else the tag and its first class. */
const nameOf = (e: SnapElement) => e.attrs["data-u-id"] ? `#${e.attrs["data-u-id"]}` : `${e.tag}${e.attrs.class ? "." + e.attrs.class.trim().split(/\s+/)[0] : ""}`;

/** What an element paints itself, in CSS px (border box from the snapshot; transforms ignored for the inner boxes). */
function ownParts(e: SnapElement): Part[] {
  const out: Part[] = [];
  if (!e.rendered || !e.box || e.computed.visibility !== "visible" || e.computed.display === "none") return out;
  const c = e.computed;
  const box: Rect = { x0: e.box.x, y0: e.box.y, x1: e.box.x + e.box.w, y1: e.box.y + e.box.h };
  const bw = SIDES.map((s) => (/^(none|hidden)$/.test(c[`border-${s}-style`] ?? "none") ? 0 : num(c[`border-${s}-width`])));
  const padding: Rect = { x0: box.x0 + bw[3], y0: box.y0 + bw[0], x1: box.x1 - bw[1], y1: box.y1 - bw[2] };
  const content: Rect = { x0: padding.x0 + num(c["padding-left"]), y0: padding.y0 + num(c["padding-top"]), x1: padding.x1 - num(c["padding-right"]), y1: padding.y1 - num(c["padding-bottom"]) };
  // a background colour and a background image are two parts (UI Toolkit fades the image over the faded colour)
  if (alpha(c["background-color"]) > 0) out.push({ what: "background", outer: box, inner: null });
  if ((c["background-image"] ?? "none") !== "none") out.push({ what: "background image", outer: box, inner: null });
  if (SIDES.some((s, i) => bw[i] > 0 && alpha(c[`border-${s}-color`]) > 0)) out.push({ what: "border", outer: box, inner: padding });
  const shadow = (c["box-shadow"] ?? "none").trim();
  if (shadow !== "none") {
    if (/\binset\b/.test(shadow)) out.push({ what: "inset shadow", outer: padding, inner: null });
    // an outer shadow paints only outside the border box; its reach is not needed to find overlaps with the element's own parts
    if (shadow.split(/,(?![^(]*\))/).some((x) => !/\binset\b/.test(x))) out.push({ what: "shadow", outer: { x0: box.x0 - 1e4, y0: box.y0 - 1e4, x1: box.x1 + 1e4, y1: box.y1 + 1e4 }, inner: box });
  }
  if (e.ns === "html" && (e.tag === "img" || e.tag === "svg")) out.push({ what: e.tag === "img" ? "image" : "icon", outer: content, inner: null });
  else if (e.ns === "svg" && e.tag === "svg") out.push({ what: "icon", outer: content, inner: null });
  return out;
}

/** Painted parts of an element and its rendered descendants (inline <svg> content counts as the svg's one icon). */
function subtreeParts(s: DomSnapshot, i: number, texts: (e: SnapElement) => boolean): Part[] {
  const e = s.elements[i];
  if (!e.rendered || e.computed.display === "none" || nonDesign(s)[i]) return [];
  const own = ownParts(e).map((p) => ({ ...p, what: `${p.what} of ${nameOf(e)}` }));
  if (texts(e) && e.box && e.computed.visibility === "visible") {
    const c = e.computed;
    const bw = SIDES.map((sd) => num(c[`border-${sd}-width`]));
    own.push({ what: `text of ${nameOf(e)}`, inner: null, outer: {
      x0: e.box.x + bw[3] + num(c["padding-left"]), y0: e.box.y + bw[0] + num(c["padding-top"]),
      x1: e.box.x + e.box.w - bw[1] - num(c["padding-right"]), y1: e.box.y + e.box.h - bw[2] - num(c["padding-bottom"]),
    } });
  }
  if (e.ns === "svg" || inSvg(s)[i]) return own;
  return [...own, ...e.children.flatMap((k) => subtreeParts(s, k, texts))];
}

const ownText = (e: SnapElement) => e.texts.length > 0 || (e.ns === "html" && (e.tag === "textarea" || e.tag === "select" ||
  (e.tag === "input" && !/^(checkbox|radio|hidden|range|color|file|image|submit|reset|button)$/i.test(e.attrs.type ?? "text"))));

/** The first two painted parts of the element's subtree that overlap, or null when they do not. */
export function overlappingParts(s: DomSnapshot, i: number): [Part, Part] | null {
  const parts = subtreeParts(s, i, ownText);
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) if (overlap(parts[a], parts[b])) return [parts[a], parts[b]];
  return null;
}

/** An opacity strictly between 0 and 1 (0 and 1 look the same for a group and for each part). */
function fractional(value: string): number | null {
  const n = opacityOf(value);
  return n !== null && n > 0 && n < 1 ? n : null;
}
/** An opacity value as a number (percentages too); null when it is not one. */
function opacityOf(value: string): number | null {
  const v = value.trim();
  const n = v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Group opacity: CSS `opacity` below 1 fades the element with everything it paints as one composited group, UI Toolkit
 * multiplies it into each painted part (measured: a disabled button's text ΔE2000 13.7–23.8 against Chromium; UI Toolkit's
 * own group filter `opacity()` is off by ΔE 1.1–2.1, docs/findings/opacity.md). An error on an element whose subtree paints
 * two parts that overlap (background and border, text or a child), for an opacity in (0, 1) in a rule or an inline style,
 * and for every fade that passes through (0, 1): a keyframe animation the element runs whose frames give opacity two
 * values (a frame without opacity holds the element's own), or opacity that differs between the element's layers (hover,
 * a class, a screen state) with a transition of it in either direction. One painted part fades the same in both.
 */
export const rule: Rule = {
  id: "U-CSS-039", severity: "error",
  check(s) {
    const c = new Collector();
    const report = (i: number, what: string, where: string) => {
      if (isExternal(s, i) || nonDesign(s)[i]) return;
      const hit = overlappingParts(s, i);
      if (!hit) return;
      c.add(s.elements[i].path, `${what} fades the ${hit[0].what} and the ${hit[1].what}, which overlap, as one group in CSS but each on its own in UI Toolkit${where}`);
    };
    for (const src of sources(s)) {
      const t = targetOf(s, src);
      if (!t) continue;
      // every reached element: whether its painted parts overlap is the element's own
      for (const i of src.elements) {
        for (const d of declsAt(src, i)) {
          if (d.name !== "opacity") continue;
          const v = resolved(s, d.value, i);
          if (fractional(v) !== null) report(i, `opacity: ${v.trim()}`, at(src, { path: s.elements[i].path, element: s.elements[i], more: 0 }));
        }
      }
    }
    // keyframes: an animation whose frames fade the element (a fractional frame, or two values it passes between)
    const animated = new Map<string, number[]>();
    for (const src of sources(s)) for (const i of src.elements) for (const d of declsAt(src, i)) {
      if (d.name !== "animation-name") continue;
      for (const name of resolved(s, d.value, i).split(",").map((x) => x.trim()).filter((x) => x && x !== "none")) {
        animated.set(name, [...(animated.get(name) ?? []), i]);
      }
    }
    for (const k of s.keyframes) {
      const targets = Array.from(new Set(animated.get(k.name) ?? []));
      const frames = k.frames.filter((f) => f.decls.some((d) => d.name === "opacity"));
      if (!targets.length || !frames.length) continue;
      const offsets = (f: (typeof frames)[number]) => f.key.split(",").map((x) => x.trim().toLowerCase()).map((x) => (x === "from" ? "0%" : x === "to" ? "100%" : x));
      for (const i of targets) {
        const value = (f: (typeof frames)[number]) => resolved(s, f.decls.filter((d) => d.name === "opacity").pop()!.value, i);
        const own = opacityOf(s.elements[i].computed.opacity ?? "1") ?? 1;
        const values = frames.map((f) => opacityOf(value(f))).filter((n): n is number => n !== null);
        // a 0% or 100% frame that does not set opacity animates from or to the element's own value
        if (["0%", "100%"].some((end) => !frames.some((f) => offsets(f).includes(end)))) values.push(own);
        const frac = frames.find((f) => fractional(value(f)) !== null);
        if (frac) { report(i, `opacity: ${value(frac).trim()}`, ` [${k.path} ${frac.key}]`); continue; }
        const distinct = Array.from(new Set(values.map((n) => Math.min(1, Math.max(0, n))))).sort((a, b) => a - b);
        if (distinct.length > 1) report(i, `the animation ${k.name}, which fades opacity between ${distinct[0]} and ${distinct[distinct.length - 1]},`, ` [${k.path}]`);
      }
    }
    // transitions: opacity that differs between layers, with a transition of it in the layer or in the base style
    const L = layoutOf(s);
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      const own = opacityOf(e.computed.opacity ?? "1") ?? 1;
      for (const cand of L.layerCands(e.index, "opacity")) {
        const v = opacityOf(resolved(s, cand.entry.value, e.index));
        if (v === null || Math.abs(Math.min(1, Math.max(0, v)) - Math.min(1, Math.max(0, own))) < 1e-6) continue;
        const moving = [cand.key, "base"].some((key) => (transitionsAt(L.ex, e.index, key, ["opacity"]).get("opacity")?.duration ?? 0) > 0);
        if (moving) report(e.index, `a transition of opacity between ${own} and ${v} (${cand.key})`, "");
      }
    }
    return c.findings(rule, FIX);
  },
};
