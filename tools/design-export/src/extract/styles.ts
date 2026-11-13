import type { StyleLayers } from "../ir/types.js";
import { CSS_SUPPORT_DATA, cssSupport } from "../lint/allowed-css.js";
import { CSS_WIDE, px, resolveVars, splitTopLevel, type SnapDecl } from "../lint/css-values.js";
import { CORNERS, cornerProperty, resolveRadii, type Corner } from "../lint/resolve/radius.js";
import { splitTransform, type TransformSplit } from "../lint/resolve/transform.js";
import { declsAt, lookup, sourcesOf } from "../lint/rules/util.js";
import { DYNAMIC_PSEUDO_CLASSES } from "../lint/selectors.js";
import type { DomSnapshot, SnapElement, SnapRule, SnapSelector, Size } from "../lint/snapshot.js";
import { breakpointOf, fmt, type Breakpoint } from "./naming.js";

/** A recorded value (var() substituted, rem in px) and the custom properties it referenced. */
export interface Entry { value: string; refs: string[] }
export type Layer = Map<string, Entry>;
/** Layer name (base, hover, …, state:<n>, bp:<n>, class:<is-*>) → property → entry. */
export type Layers = Map<string, Layer>;

export interface StyleContext {
  /** Presentational attribute declarations per element index (CDP attributesStyle: img/svg width and height, hidden). */
  presentational?: Map<number, SnapDecl[]>;
  /** Untransformed border-box size per screen state and element index, measured with the state class on the root. */
  stateBoxes?: Map<string, Map<number, Size>>;
}

export const PSEUDO_STATES = new Set(["hover", "active", "focus", "disabled", "checked"]);
export const isAnimProperty = (p: string) => /^(transition|animation)(-|$)/.test(p);
const SIDES = ["top", "right", "bottom", "left"] as const;
const RADII = CORNERS.map(cornerProperty);
const KEEP_DROPPED = new Set(["box-shadow", "background-image", "line-height", ...SIDES.map((s) => `border-${s}-style`)]);
/** Accepted properties with no effect in UI Toolkit ("dropped" in the CSS support data); baked ones stay for Task 10. */
const NO_EFFECT = new Set(Object.entries(CSS_SUPPORT_DATA.properties)
  .filter(([n, p]) => p.handling === "dropped" && !KEEP_DROPPED.has(n) && !isAnimProperty(n)).map(([n]) => n));
const INHERITED = new Set([...CSS_SUPPORT_DATA.browserDefaults.inherited, "font-family", "font-size", "font-weight", "font-style",
  "font-variant-caps", "line-height", "cursor", "visibility"]);
const COLOR_PROPS = new Set(["color", "background-color", ...SIDES.map((s) => `border-${s}-color`)]);
const WIDTH_KEYWORDS: Record<string, string> = { thin: "1px", medium: "3px", thick: "5px" };
const FLEX_ONLY = new Set(["align-items", "align-content", "justify-content", "flex-direction", "flex-wrap", "row-gap", "column-gap"]);
/** Inherited text properties written on every text node (R32); the first five always, from the computed style if nobody declares them. */
export const TEXT_INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-align", "white-space-collapse", "text-wrap-mode"];
const TEXT_ALWAYS = new Set(TEXT_INHERITED.slice(0, 5));

/**
 * Whether a browser-default property renders, judged like lint U-CSS-026 (which the extraction must agree with): an
 * inherited one that differs from the parent, a non-inherited one that differs from the CSS initial value, border
 * properties only on sides with width, flex alignment only on flex containers.
 */
function uaRenders(e: SnapElement, prop: string): boolean {
  const d = cssSupport.browserDefaults;
  const ua = e.ua[prop];
  if (d.inherited.includes(prop)) return ua.value !== ua.parent;
  const side = /^border-(top|right|bottom|left)-(style|color)$/.exec(prop);
  if (side && e.computed[`border-${side[1]}-width`] === "0px") return false;
  if (FLEX_ONLY.has(prop) && !/flex|grid/.test(e.computed.display)) return false;
  return !(d.initial[prop] ?? []).includes(ua.value);
}

// ---- values -------------------------------------------------------------------------------------------------

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 165, 0],
  purple: [128, 0, 128], pink: [255, 192, 203], brown: [165, 42, 42], silver: [192, 192, 192], gold: [255, 215, 0],
  navy: [0, 0, 128], teal: [0, 128, 128], lime: [0, 255, 0], maroon: [128, 0, 0], olive: [128, 128, 0], aqua: [0, 255, 255],
  fuchsia: [255, 0, 255],
};

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** One colour as `#rrggbb` (opaque) or `rgba(r, g, b, a)`; any other text is returned unchanged. */
export function normalizeColor(value: string): string {
  const t = value.trim().toLowerCase();
  let rgb: [number, number, number] | null = null, a = 1;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(t);
  if (t === "transparent") { rgb = [0, 0, 0]; a = 0; }
  else if (NAMED[t]) rgb = NAMED[t];
  else if (hex) {
    const h = hex[1].length <= 4 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)) as [number, number, number];
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else if (fn) {
    const body = fn[2].includes(",") ? fn[2].split(",") : fn[2].replace("/", " / ").split(/\s+/).filter((x) => x && x !== "/");
    const num = (x: string, scale: number) => (x.trim().endsWith("%") ? (parseFloat(x) / 100) * scale : parseFloat(x));
    if (body.length < 3 || body.length > 4) return value;
    if (body.length === 4) a = num(body[3], 1);
    if (fn[1].startsWith("rgb")) rgb = [num(body[0], 255), num(body[1], 255), num(body[2], 255)];
    else rgb = hslToRgb(parseFloat(body[0]), num(body[1], 1), num(body[2], 1));
    if ([...rgb, a].some((n) => !Number.isFinite(n))) return value;
  }
  if (!rgb) return value;
  const c = rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))));
  a = Math.max(0, Math.min(1, a));
  return a >= 1 ? `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${fmt(a)})`;
}

/** `1.5rem` → `24px` (root font size); values with strings or url() are left alone. */
export function remToPx(v: string, rootFontSize: number): string {
  if (!/\drem\b/i.test(v) || /url\(|["']/i.test(v)) return v;
  return v.replace(/(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)rem\b/gi, (_m, n: string) => `${fmt(Number(n) * rootFontSize)}px`);
}

export const varRefs = (v: string): string[] => Array.from(v.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]);

/** A declaration's value as recorded: var() substituted at element `i`, rem resolved. */
export function resolveValue(s: DomSnapshot, i: number, raw: string): Entry {
  return { value: remToPx(resolveVars(raw, lookup(s, i)), s.rootFontSize), refs: varRefs(raw) };
}

/** Transform split as IR values (translate "x y", rotate "<n>deg", scale "x y"); null components are absent. */
export function transformValues(sp: TransformSplit): Record<"translate" | "rotate" | "scale", string | null> {
  return {
    translate: sp.translate ? sp.translate.join(" ") : null,
    rotate: sp.rotate !== null ? `${fmt(sp.rotate)}deg` : null,
    scale: sp.scale ? `${fmt(sp.scale[0])} ${fmt(sp.scale[1])}` : null,
  };
}

// ---- cascade ------------------------------------------------------------------------------------------------

interface Cand { prop: string; entry: Entry; weight: number; spec: [number, number, number]; order: number; layer: string }
const better = (a: Cand, b: Cand) =>
  a.weight - b.weight || a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order;

/**
 * Specified style layers per element, from the lint snapshot: browser defaults that render, presentational
 * attributes, author rules and inline styles, cascaded per layer (a layer records what wins when only it and base
 * apply), then lowered to what the IR carries.
 */
export class StyleExtractor {
  readonly states = new Set<string>();
  readonly breakpoints = new Map<string, Breakpoint>();
  readonly root: number;
  private readonly rawCache = new Map<number, Layers>();
  private readonly doneCache = new Map<number, Layers>();
  private readonly reach = new Map<SnapSelector, Set<number>>();

  constructor(readonly s: DomSnapshot, readonly ctx: StyleContext = {}) {
    this.root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
  }

  private reaches(sel: SnapSelector, i: number): boolean {
    let set = this.reach.get(sel);
    if (!set) { set = new Set(sel.elements ?? []); this.reach.set(sel, set); }
    return set.has(i);
  }

  /** The layer a selector's match at element `i` belongs to; null when it can never apply there. Throws for what the IR cannot express. */
  private layerOf(sel: SnapSelector, rule: SnapRule, i: number): string | null {
    const where = () => `${rule.path} reaching ${this.s.elements[i].path}`;
    const dims: string[] = [];
    const comps = sel.parsed.compounds;
    for (let k = 0; k < comps.length; k++) {
      const subject = k === comps.length - 1;
      for (const x of comps[k].simples) {
        if (x.kind === "pseudo-class" && DYNAMIC_PSEUDO_CLASSES.has(x.name)) {
          if (!PSEUDO_STATES.has(x.name)) throw new Error(`${where()}: :${x.name} has no IR layer (only :${Array.from(PSEUDO_STATES).join(", :")})`);
          if (!subject) throw new Error(`${where()}: :${x.name} on an ancestor ("${sel.text}") has no IR layer; put the pseudo-class on the styled element itself`);
          dims.push(x.name);
        } else if (x.kind === "class" && /^is-/.test(x.name)) {
          if (!subject) throw new Error(`${where()}: the state class .${x.name} on an ancestor ("${sel.text}") has no IR layer; toggle it on the styled element itself`);
          dims.push(`class:${x.name}`);
        } else if (x.kind === "class" && /^state-./.test(x.name)) {
          // the view swaps state classes on the screen root only
          if (subject && i !== this.root) return null;
          dims.push(`state:${x.name.slice("state-".length)}`);
        }
      }
    }
    let bp: Breakpoint | null;
    try { bp = breakpointOf(rule.media); } catch (e) { throw new Error(`${where()}: ${(e as Error).message}`); }
    if (bp) {
      const prev = this.breakpoints.get(bp.name);
      if (prev && JSON.stringify(prev) !== JSON.stringify(bp)) throw new Error(`${where()}: breakpoint ${bp.name} is defined twice differently`);
      this.breakpoints.set(bp.name, bp);
      dims.push(`bp:${bp.name}`);
    }
    const uniq = Array.from(new Set(dims));
    if (uniq.length > 1) throw new Error(`${where()}: "${sel.text}" combines ${uniq.join(" and ")}; the IR has one layer per rule (base, a pseudo-state, a state, a breakpoint or an is-* class)`);
    for (const d of uniq) if (d.startsWith("state:")) this.states.add(d.slice("state:".length));
    return uniq[0] ?? "base";
  }

  /** Cascade winners per layer, including transition-* and animation-* (the source of anims). */
  raw(i: number): Layers {
    const hit = this.rawCache.get(i);
    if (hit) return hit;
    const { s } = this;
    const e = s.elements[i];
    const cands: Cand[] = [];
    const add = (d: SnapDecl, weight: number, spec: [number, number, number], order: number, layer: string) => {
      if (d.name.startsWith("--") || d.invalid) return;
      if (/^revert(-layer)?$/i.test(d.value.trim())) return; // back to the browser default: lower sources decide
      cands.push({ prop: d.name, entry: resolveValue(s, i, d.value), weight, spec, order, layer });
    };
    for (const [prop, ua] of Object.entries(e.ua)) {
      if (uaRenders(e, prop)) cands.push({ prop, entry: { value: ua.value, refs: [] }, weight: 0, spec: [0, 0, 0], order: -2, layer: "base" });
    }
    for (const d of this.ctx.presentational?.get(i) ?? []) {
      const value = /^(width|height)$/.test(d.name) && /^\d+(\.\d+)?$/.test(d.value.trim()) ? `${d.value.trim()}px` : d.value;
      add({ ...d, value }, 1, [0, 0, 0], -1, "base");
    }
    for (const src of sourcesOf(s)[i]) {
      if (src.kind === "inline") {
        for (const d of src.decls) add(d, d.important ? 5 : 3, [0, 0, 0], Number.MAX_SAFE_INTEGER, "base");
        continue;
      }
      const rule = src.rule!;
      for (const sel of rule.selectors) {
        if (sel.pseudoElement || !this.reaches(sel, i)) continue;
        const layer = this.layerOf(sel, rule, i);
        if (layer === null) continue;
        for (const d of declsAt(src, i)) add(d, d.important ? 4 : 2, sel.specificity, rule.index, layer);
      }
    }
    // `all` stands for every property the element's other sources set
    const props = new Set(cands.filter((c) => c.prop !== "all").map((c) => c.prop));
    const byProp = new Map<string, Cand[]>();
    for (const c of cands) {
      for (const p of c.prop === "all" ? props : [c.prop]) byProp.set(p, [...(byProp.get(p) ?? []), { ...c, prop: p }]);
    }
    const out: Layers = new Map([["base", new Map()]]);
    const win = (pool: Cand[]) => pool.reduce((m, c) => (better(c, m) >= 0 ? c : m));
    const set = (layer: string, c: Cand) => { if (!out.has(layer)) out.set(layer, new Map()); out.get(layer)!.set(c.prop, c.entry); };
    for (const [, list] of byProp) {
      const base = list.filter((c) => c.layer === "base");
      if (base.length) set("base", win(base));
      for (const layer of new Set(list.map((c) => c.layer))) {
        if (layer === "base") continue;
        const w = win(list.filter((c) => c.layer === "base" || c.layer === layer));
        if (w.layer === layer) set(layer, w);
      }
    }
    this.rawCache.set(i, out);
    return out;
  }

  /** Elements whose border radii need a box in some layer (measured per state before `layers` runs). */
  hasRadius(i: number): boolean {
    return Array.from(this.raw(i).values()).some((m) => RADII.some((k) => m.has(k)));
  }

  private stateBox(state: string, i: number): Size | undefined { return this.ctx.stateBoxes?.get(state)?.get(i); }

  private firstStateBox(i: number): Size | null {
    for (const st of Array.from(this.ctx.stateBoxes?.keys() ?? []).sort()) { const b = this.stateBox(st, i); if (b) return b; }
    return null;
  }

  /** Style layers as the IR records them (see the module notes in tree.ts); display always set in base. */
  layers(i: number): Layers {
    const hit = this.doneCache.get(i);
    if (hit) return hit;
    const { s } = this;
    const e = s.elements[i];
    const out: Layers = new Map();
    for (const [name, m] of this.raw(i)) {
      const l: Layer = new Map();
      for (const [p, en] of m) {
        if (isAnimProperty(p) || p === "all" || NO_EFFECT.has(p)) continue;
        let v = en.value.trim().toLowerCase();
        if (CSS_WIDE.has(v)) {
          if (name === "base") continue; // the IR starts from initial values; inheritance is USS's own
          if (v === "unset") v = INHERITED.has(p) ? "inherit" : "initial";
          if (!cssSupport.property(p)) continue;
          l.set(p, { value: v, refs: en.refs });
          continue;
        }
        if (!cssSupport.property(p) && cssSupport.isInitialValue(p, en.value)) continue; // shorthand residue
        l.set(p, COLOR_PROPS.has(p) ? { value: normalizeColor(en.value), refs: en.refs } : en);
      }
      out.set(name, l);
    }
    if (!out.has("base")) out.set("base", new Map());
    const base = out.get("base")!;
    const colorAt = (layer: Layer) => layer.get("color")?.value ?? base.get("color")?.value ?? normalizeColor(e.computed.color ?? "");

    // borders as they render: no style → no border; width keywords → px; currentcolor → the element's colour
    const baseBefore = new Map(base);
    const visible = (st: string | undefined) => st !== undefined && !/^(none|hidden|initial)$/.test(st);
    for (const side of SIDES) {
      const W = `border-${side}-width`, S = `border-${side}-style`, C = `border-${side}-color`;
      const fix = (layer: Layer) => {
        const w = layer.get(W);
        if (w && WIDTH_KEYWORDS[w.value]) layer.set(W, { value: WIDTH_KEYWORDS[w.value], refs: w.refs });
        const c = layer.get(C);
        if (c && c.value === "currentcolor") layer.set(C, { value: colorAt(layer), refs: c.refs });
      };
      const baseStyle = base.get(S)?.value;
      if (visible(baseStyle)) {
        if (!base.has(W)) base.set(W, { value: "medium", refs: [] }); // CSS's initial width, USS starts at 0
        fix(base);
      } else { base.delete(W); base.delete(S); base.delete(C); }
      for (const [name, layer] of out) {
        if (name === "base" || ![W, S, C].some((k) => layer.has(k))) continue;
        const st = layer.get(S)?.value ?? baseStyle;
        if (!visible(st)) {
          layer.delete(C);
          if (visible(baseStyle)) layer.set(W, { value: "0px", refs: [] }); else layer.delete(W);
          if (!visible(baseStyle)) layer.delete(S);
          continue;
        }
        if (!visible(baseStyle)) {
          // the base draws no border: the layer brings the width and colour the base declared (or CSS's initial ones)
          if (!layer.has(W)) layer.set(W, baseBefore.get(W) ?? { value: "medium", refs: [] });
          if (!layer.has(C) && baseBefore.has(C)) layer.set(C, baseBefore.get(C)!);
        }
        fix(layer);
      }
    }

    // transform → translate / rotate / scale (R32)
    const all = Array.from(out.values());
    if (all.some((m) => m.has("transform"))) {
      if (all.some((m) => m.has("translate") || m.has("rotate") || m.has("scale"))) {
        throw new Error(`${e.path}: transform together with translate/rotate/scale cannot be split into the IR's translate, rotate and scale; use one of the two forms`);
      }
      const lctx = { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize };
      const split = (en: Entry): TransformSplit => {
        const v = CSS_WIDE.has(en.value.trim()) ? "none" : en.value;
        const r = splitTransform(v, e.size ?? undefined, lctx);
        if (!r.ok) throw new Error(`${e.path}: transform: ${en.value}: ${r.reason}`);
        return r.split;
      };
      const baseSplit: TransformSplit = base.has("transform") ? split(base.get("transform")!) : { translate: null, rotate: null, scale: null };
      for (const [name, layer] of out) {
        const en = layer.get("transform");
        if (!en) continue;
        layer.delete("transform");
        const vals = transformValues(name === "base" ? baseSplit : split(en));
        const baseVals = transformValues(baseSplit);
        for (const k of ["translate", "rotate", "scale"] as const) {
          if (vals[k] !== null) layer.set(k, { value: vals[k]!, refs: en.refs });
          else if (name !== "base" && baseVals[k] !== null) layer.set(k, { value: "none", refs: [] });
        }
      }
    }

    // border radii → one px value per corner, per layer box (R24/R26)
    if (all.some((m) => RADII.some((k) => m.has(k)))) {
      const lctx = { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize };
      const baseBox = e.size ?? this.firstStateBox(i);
      const resolve = (layer: Layer | null, box: Size | null) => {
        const corners: Partial<Record<Corner, string>> = {};
        for (const c of CORNERS) {
          const v = layer?.get(cornerProperty(c))?.value ?? base.get(cornerProperty(c))?.value;
          if (v !== undefined && !CSS_WIDE.has(v)) corners[c] = v;
        }
        return box ? resolveRadii(corners, box, lctx) : null;
      };
      const rBase = resolve(null, baseBox);
      for (const [name, layer] of out) {
        const declares = RADII.some((k) => layer.has(k));
        if (name === "base") {
          if (rBase) for (const c of CORNERS) if (layer.has(cornerProperty(c))) layer.set(cornerProperty(c), { value: `${fmt(rBase[c].x)}px`, refs: layer.get(cornerProperty(c))!.refs });
          continue;
        }
        const box = (name.startsWith("state:") ? this.stateBox(name.slice(6), i) : undefined) ?? baseBox;
        const boxChanged = !!box && !!baseBox && (box.w !== baseBox.w || box.h !== baseBox.h);
        if (!declares && !(boxChanged && RADII.some((k) => base.has(k)))) continue;
        const r = resolve(layer, box);
        if (!r) continue;
        for (const c of CORNERS) {
          const k = cornerProperty(c);
          if (layer.has(k) || (rBase && Math.abs(rBase[c].x - r[c].x) > 1e-6)) layer.set(k, { value: `${fmt(r[c].x)}px`, refs: layer.get(k)?.refs ?? [] });
        }
      }
    }

    // presentational aspect-ratio ("auto 64 / 32"): the ratio, and only when it can size the element
    const ar = base.get("aspect-ratio");
    const m = ar && /^auto\s+(.+)$/.exec(ar.value.trim());
    if (m) {
      const sized = (k: string) => base.has(k) && base.get(k)!.value !== "auto";
      if (sized("width") && sized("height")) base.delete("aspect-ratio"); else base.set("aspect-ratio", { value: m[1], refs: ar!.refs });
    }

    // display of the default state, explicit on every element (blockified like CSS where the value is the design's)
    const own = base.get("display");
    let d = own?.value ?? e.computed.display ?? "block";
    if (d === "list-item") d = "block";
    const parent = e.parent >= 0 ? s.elements[e.parent] : null;
    if (own && ((parent && /flex/.test(parent.computed.display)) || e.computed.position === "absolute")) {
      d = ({ inline: "block", "inline-block": "block", "inline-flex": "flex" } as Record<string, string>)[d] ?? d;
    }
    base.set("display", { value: d, refs: own?.refs ?? [] });

    // CSS's initial content-box renders differently from USS (always border-box) on a sized element with padding or
    // border (findings O-6): record it so the compiler can see it
    const c = e.computed;
    const sized = ["width", "height"].some((k) => base.has(k) && base.get(k)!.value !== "auto");
    const extras = SIDES.some((sd) => (px(c[`padding-${sd}`]) ?? 0) !== 0 || (px(c[`border-${sd}-width`]) ?? 0) !== 0);
    if (!base.has("box-sizing") && c["box-sizing"] === "content-box" && sized && extras) base.set("box-sizing", { value: "content-box", refs: [] });

    for (const [name, layer] of out) if (name !== "base" && layer.size === 0) out.delete(name);
    this.doneCache.set(i, out);
    return out;
  }

  /**
   * Adds the inherited text properties (R32) to a text node's layers: the nearest ancestor declaration, or the
   * computed value for colour and font. A property an ancestor changes in a pseudo-state or is-* class layer is left
   * to USS inheritance (an explicit value would stop it); ancestors' state and breakpoint layers are copied.
   */
  addInheritedText(i: number, layers: Layers): void {
    const { s } = this;
    const e = s.elements[i];
    const base = layers.get("base")!;
    for (const p of TEXT_INHERITED) {
      if (base.has(p)) continue;
      let found: Entry | null = null, skip = false;
      const scoped = new Map<string, Entry>();
      for (let a = e.parent; a >= 0; a = s.elements[a].parent) {
        const la = this.layers(a);
        for (const [name, m] of la) {
          if (name === "base" || !m.has(p)) continue;
          if (name.startsWith("state:") || name.startsWith("bp:")) { if (!scoped.has(name)) scoped.set(name, m.get(p)!); }
          else skip = true;
        }
        if (la.get("base")!.has(p)) { found = la.get("base")!.get(p)!; break; }
      }
      if (skip) continue;
      const relative = (v: string) => (p === "font-size" && /(%|em)$|^(larger|smaller)$/.test(v)) || (p === "font-weight" && /^(bolder|lighter)$/.test(v));
      if (found && relative(found.value)) found = null;
      const computed = e.computed[p];
      const value: Entry | null = found ?? (TEXT_ALWAYS.has(p) && computed ? { value: p === "color" ? normalizeColor(computed) : computed, refs: [] } : null);
      if (value) base.set(p, value);
      for (const [name, v] of scoped) {
        if (relative(v.value) || (value && v.value === value.value)) continue;
        if (!layers.has(name)) layers.set(name, new Map());
        if (!layers.get(name)!.has(p)) layers.get(name)!.set(p, v);
      }
    }
  }
}

export function toStyleLayers(layers: Layers): StyleLayers {
  const out: StyleLayers = {};
  for (const [name, m] of layers) out[name] = Object.fromEntries(Array.from(m, ([p, en]) => [p, en.value]));
  return out;
}

/** Specified style layers of one element (no presentational attributes or state boxes unless given). */
export function specifiedLayers(el: SnapElement, s: DomSnapshot, ctx: StyleContext = {}): StyleLayers {
  return toStyleLayers(new StyleExtractor(s, ctx).layers(el.index));
}

/** Comma list items of a property value (top level). */
export const listOf = (v: string | undefined, fallback: string): string[] => splitTopLevel(v ?? fallback, ",");
