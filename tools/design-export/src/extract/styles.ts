import type { StyleLayers } from "../ir/types.js";
import { CSS_SUPPORT_DATA, cssSupport } from "../lint/allowed-css.js";
import { CSS_WIDE, LENGTH_RE, px, resolveVars, splitTopLevel, type SnapDecl } from "../lint/css-values.js";
import { stateAncestor } from "../lint/ancestors.js";
import { breakpointsOf, MediaError, type Breakpoint } from "../lint/resolve/media.js";
import { CORNERS, cornerProperty, lengthPx, resolveRadii, type Corner } from "../lint/resolve/radius.js";
import { splitTransform, type TransformSplit } from "../lint/resolve/transform.js";
import { declsAt, lookup, sourcesOf } from "../lint/rules/util.js";
import { designChildren } from "../lint/repeat.js";
import { isTextElement } from "../lint/text-runs.js";
import { DYNAMIC_PSEUDO_CLASSES } from "../lint/selectors.js";
import type { DomSnapshot, SnapElement, SnapRule, SnapSelector, Size } from "../lint/snapshot.js";
import { DESIGN_ORIGIN, KIT_PREFIX } from "../load.js";
import { dimsOf, keyOf, PSEUDO_STATES, satisfiable, subset, toAncestor, toDescendant, union } from "./layers.js";
import { fmt } from "./naming.js";

/** A recorded value (var() substituted, rem in px, keywords concrete), the custom properties it read, and the URL its url()s resolve against. */
export interface Entry { value: string; refs: string[]; base?: string }
export type Layer = Map<string, Entry>;
/** Layer key (see layers.ts) → property → entry. */
export type Layers = Map<string, Layer>;

export interface StyleContext {
  /** Presentational attribute declarations per element index (CDP attributesStyle: img/svg width and height, hidden). */
  presentational?: Map<number, SnapDecl[]>;
  /** IR id per element index, assigned before the cascade (ancestor layers name ancestors by id). */
  ids?: Map<number, string>;
  /** URL of the design page (base of relative url() in its style elements and inline styles). */
  docUrl?: string;
  /** Untransformed border-box size per layer key and element index, measured with that layer applied. */
  boxes?: Map<string, Map<number, Size>>;
  /** Chromium's longhand expansion of shorthand values (`name\u0000value` → longhands), for var() users per layer. */
  expansions?: Map<string, SnapDecl[] | null>;
}

const expansionKey = (name: string, value: string) => `${name}\u0000${value}`;

export { PSEUDO_STATES };
export const isAnimProperty = (p: string) => /^(transition|animation)(-|$)/.test(p);
const SIDES = ["top", "right", "bottom", "left"] as const;
const RADII = CORNERS.map(cornerProperty);
const KEEP_DROPPED = new Set(["box-shadow", "background-image", "line-height", ...SIDES.map((s) => `border-${s}-style`)]);
/** Accepted properties with no effect in UI Toolkit ("dropped" in the CSS support data); shadows and gradients stay for the bake step. */
const NO_EFFECT = new Set(Object.entries(CSS_SUPPORT_DATA.properties)
  .filter(([n, p]) => p.handling === "dropped" && !KEEP_DROPPED.has(n) && !isAnimProperty(n)).map(([n]) => n));
export const INHERITED = new Set([...CSS_SUPPORT_DATA.browserDefaults.inherited, "font-family", "font-size", "font-weight", "font-style",
  "font-variant-caps", "line-height", "cursor", "visibility", "pointer-events"]);
const COLOR_PROPS = new Set(["color", "background-color", ...SIDES.map((s) => `border-${s}-color`)]);
const WIDTH_KEYWORDS: Record<string, string> = { thin: "1px", medium: "3px", thick: "5px" };
const FLEX_ONLY = new Set(["align-items", "align-content", "justify-content", "flex-direction", "flex-wrap", "row-gap", "column-gap"]);
const INSETS = ["top", "right", "bottom", "left"];

/** CSS initial values (as the IR writes them) of the properties the pipeline supports: `initial` becomes these. */
export const INITIAL: Record<string, string> = {
  color: "#000000", "background-color": "rgba(0, 0, 0, 0)", "background-image": "none", opacity: "1", visibility: "visible",
  display: "inline", position: "static", top: "auto", right: "auto", bottom: "auto", left: "auto", "z-index": "auto",
  width: "auto", height: "auto", "min-width": "auto", "min-height": "auto", "max-width": "none", "max-height": "none",
  "aspect-ratio": "auto", "box-sizing": "content-box", "flex-direction": "row", "flex-wrap": "nowrap", "flex-grow": "0",
  "flex-shrink": "1", "flex-basis": "auto", "justify-content": "flex-start", "align-items": "stretch", "align-self": "auto",
  "align-content": "stretch", "row-gap": "0px", "column-gap": "0px", "overflow-x": "visible", "overflow-y": "visible",
  "pointer-events": "auto", "font-size": "16px", "font-weight": "400", "font-style": "normal", "letter-spacing": "normal",
  "word-spacing": "0px", "line-height": "normal", "text-align": "left", "text-overflow": "clip", "text-shadow": "none",
  "white-space-collapse": "collapse", "text-wrap-mode": "wrap", translate: "none", rotate: "none", scale: "none",
  transform: "none", "transform-origin": "50% 50%", "box-shadow": "none", "background-size": "auto", "background-repeat": "repeat",
  "background-position-x": "0%", "background-position-y": "0%",
  ...Object.fromEntries(SIDES.flatMap((s) => [[`margin-${s}`, "0px"], [`padding-${s}`, "0px"], [`border-${s}-width`, "medium"],
    [`border-${s}-style`, "none"], [`border-${s}-color`, "currentcolor"]])),
  ...Object.fromEntries(RADII.map((r) => [r, "0px"])),
};

/** Inherited text properties written on every text node; the first five always (computed if nobody declares them). */
export const TEXT_INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-align", "white-space-collapse", "text-wrap-mode", "text-shadow"];
const ALWAYS = new Set(TEXT_INHERITED.slice(0, 5));

/** Whether a browser-default property renders, judged like lint U-CSS-026 (which the extraction must agree with). */
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
  fuchsia: [255, 0, 255], canvastext: [0, 0, 0],
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

/** A declaration's value as recorded in the default context: var() substituted at element `i`, rem resolved. */
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

const NONE_SPLIT: TransformSplit = { translate: null, rotate: null, scale: null };

/** Base URL of a stylesheet label from the snapshot (`style:0`, `kit:tokens.css`, `css/a.css`). */
function sheetUrl(label: string, docUrl: string | undefined): string | undefined {
  if (/^(style|adopted):/.test(label)) return docUrl;
  if (label.startsWith("kit:")) return DESIGN_ORIGIN + KIT_PREFIX + label.slice(4).split("/").map(encodeURIComponent).join("/");
  if (/^https?:/.test(label)) return label;
  return DESIGN_ORIGIN + "/" + label.split("/").map(encodeURIComponent).join("/");
}

/**
 * One text shadow as `<x>px <y>px <blur>px <colour>` (USS order; blur 0 when omitted, colours #rrggbb or rgba()); `none`
 * stays. Without a colour (or with currentcolor) the colour is `color`, or the word currentcolor when `color` is null (each
 * element resolves it with its own colour, as CSS does: see resolveTextShadowColour). Throws on a list (UI Toolkit draws
 * one text shadow; lint U-CSS-023).
 */
export function normalizeTextShadow(value: string, color: string | null, ctx: { fontSize?: number; rootFontSize?: number } = {}, where = "text-shadow"): string {
  const v = value.trim();
  if (/^none$/i.test(v)) return "none";
  const items = splitTopLevel(v, ",");
  if (items.length !== 1) throw new Error(`${where}: text-shadow ${v}: UI Toolkit draws one text shadow`);
  const lens: number[] = [];
  const rest: string[] = [];
  for (const t of splitTopLevel(items[0], " ")) {
    if (LENGTH_RE.test(t)) {
      const n = lengthPx(t, 0, { fontSize: ctx.fontSize ?? 16, rootFontSize: ctx.rootFontSize ?? 16 });
      if (n === null) throw new Error(`${where}: text-shadow length ${t} cannot be resolved`);
      lens.push(n);
    } else rest.push(t);
  }
  if (lens.length < 2 || lens.length > 3) throw new Error(`${where}: text-shadow ${v} is not one shadow`);
  const c = rest.join(" ");
  const col = !c || /^currentcolor$/i.test(c) ? color ?? "currentcolor" : normalizeColor(c);
  return `${fmt(lens[0])}px ${fmt(lens[1])}px ${fmt(lens[2] ?? 0)}px ${col}`;
}

/**
 * Gives a text shadow written with currentcolor the node's colour in every layer: where the shadow is set, and where only
 * the colour changes (CSS resolves currentcolor per element and per state; USS needs the colour itself).
 */
export function resolveTextShadowColour(layers: Layers, baseColor: string): void {
  const at = (key: string, prop: string): Entry | undefined => {
    const dims = dimsOf(key);
    let best: { n: number; key: string; v: Entry } | null = null;
    for (const [k, m] of layers) {
      const v = m.get(prop), kd = dimsOf(k);
      if (!v || !subset(kd, dims)) continue;
      if (!best || kd.length > best.n || (kd.length === best.n && k < best.key)) best = { n: kd.length, key: k, v };
    }
    return best?.v;
  };
  const updates: [Layer, Entry][] = [];
  for (const [key, m] of layers) {
    const ts = at(key, "text-shadow");
    if (!ts || !/ currentcolor$/.test(ts.value)) continue;
    if (key !== "base" && !m.has("text-shadow") && !m.has("color")) continue;
    updates.push([m, { ...ts, value: ts.value.replace(/currentcolor$/, at(key, "color")?.value ?? baseColor) }]);
  }
  for (const [m, en] of updates) m.set("text-shadow", en);
}

// ---- cascade ------------------------------------------------------------------------------------------------

export interface Cand { prop: string; entry: Entry; weight: number; spec: [number, number, number]; order: number; dims: string[]; key: string }
const better = (a: Cand, b: Cand) =>
  a.weight - b.weight || a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order;
const winner = (pool: Cand[]) => pool.reduce((m, c) => (better(c, m) >= 0 ? c : m));
const MAX_UNION_SOURCES = 8;

/** Unions of two or more of the given dimension sets that can hold at once (co-active layers). */
export function unions(sets: string[][], bps: ReadonlyMap<string, Breakpoint>): string[][] {
  const out = new Map<string, string[]>();
  const n = sets.length;
  if (n < 2) return [];
  if (n > MAX_UNION_SOURCES) {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const u = union(sets[a], sets[b]); if (satisfiable(u, bps)) out.set(keyOf(u), u); }
    return Array.from(out.values());
  }
  for (let mask = 1; mask < 1 << n; mask++) {
    if ((mask & (mask - 1)) === 0) continue; // single sets are authored already
    let u: string[] = [];
    for (let k = 0; k < n; k++) if (mask & (1 << k)) u = union(u, sets[k]);
    if (satisfiable(u, bps)) out.set(keyOf(u), u);
  }
  return Array.from(out.values());
}

export interface InheritCopy { prop: string; from: number; fromKey: string; key: string }

/**
 * Specified style layers per element, from the lint snapshot. Sources: browser defaults that render, presentational
 * attributes, author rules, inline styles. Each layer records what wins (CSS cascade with !important and
 * specificity) when exactly its dimensions hold; when two layers that can hold at once set the same property, their
 * union is recorded too, so the IR never leaves precedence to the compiler.
 */
export class StyleExtractor {
  readonly states = new Set<string>();
  readonly breakpoints = new Map<string, Breakpoint>();
  /** Shorthand values (var() substituted for a layer) whose longhands are not in `ctx.expansions` yet. */
  readonly missingExpansions = new Map<string, { name: string; value: string }>();
  readonly root: number;
  private readonly candCache = new Map<number, Cand[]>();
  private readonly propCache = new Map<number, Map<string, Cand[]>>();
  private readonly rawCache = new Map<number, Layers>();
  private readonly doneCache = new Map<number, Layers>();
  private readonly reach = new Map<SnapSelector, Set<number>>();
  private rootCustomCache: Cand[] | null = null;

  constructor(readonly s: DomSnapshot, readonly ctx: StyleContext = {}) {
    this.root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
  }

  private parent(i: number) { return this.s.elements[i].parent; }
  private id(i: number) { return this.ctx.ids?.get(i); }

  private reaches(sel: SnapSelector, i: number): boolean {
    let set = this.reach.get(sel);
    if (!set) { set = new Set(sel.elements ?? []); this.reach.set(sel, set); }
    return set.has(i);
  }

  private registerBreakpoints(rule: SnapRule, where: () => string): Breakpoint[] | "always" | null {
    let r;
    try { r = breakpointsOf(rule.media); } catch (e) { if (e instanceof MediaError) throw new Error(`${where()}: ${e.message}`); throw e; }
    if (r.always) return "always";
    for (const bp of r.breakpoints) this.breakpoints.set(bp.name, bp);
    return r.breakpoints.length ? r.breakpoints : null;
  }

  /** Dimension sets a selector's match at element `i` applies in (one per breakpoint of a media list); null: never. */
  private selectorDims(sel: SnapSelector, rule: SnapRule, i: number): string[][] | null {
    const where = () => `${rule.path} reaching ${this.s.elements[i].path}`;
    const dims: string[] = [];
    const comps = sel.parsed.compounds;
    const ancestorId = (k: number): string => {
      const d = sel.dynamicAncestors.find((x) => x.compound === k);
      const r = d ? stateAncestor(this.s, sel, d, i) : { problem: `no ancestor recorded for compound ${k} of "${sel.text}"` };
      if ("problem" in r) throw new Error(`${where()}: ${r.problem}`);
      const id = this.id(r.index);
      if (!id) throw new Error(`${where()}: "${sel.text}" names ${this.s.elements[r.index].path}, which is not an element of the compiled screen`);
      return id;
    };
    for (let k = 0; k < comps.length; k++) {
      const subject = k === comps.length - 1;
      for (const x of comps[k].simples) {
        if (x.kind === "pseudo-class" && DYNAMIC_PSEUDO_CLASSES.has(x.name)) {
          if (!PSEUDO_STATES.has(x.name)) throw new Error(`${where()}: :${x.name} has no IR layer (only :${Array.from(PSEUDO_STATES).join(", :")})`);
          dims.push(subject ? x.name : `anc(${ancestorId(k)}):${x.name}`);
        } else if (x.kind === "class" && /^is-/.test(x.name)) {
          dims.push(subject ? `class:${x.name}` : `anc(${ancestorId(k)}):class:${x.name}`);
        } else if (x.kind === "class" && /^state-./.test(x.name)) {
          // the view swaps state classes on the screen root only
          if (subject && i !== this.root) return null;
          dims.push(`state:${x.name.slice("state-".length)}`);
        }
      }
    }
    const bps = this.registerBreakpoints(rule, where);
    if (bps === null) return null;
    const alts = (bps === "always" ? [dims] : bps.map((bp) => [...dims, `bp:${bp.name}`])).filter((d) => satisfiable(d, this.breakpoints));
    if (!alts.length) return null;
    for (const d of alts) for (const x of d) if (x.startsWith("state:")) this.states.add(x.slice("state:".length));
    return alts;
  }

  /** Custom properties declared by `:root` / `html` rules (not elements of the snapshot), with their breakpoints. */
  private rootCustom(): Cand[] {
    if (this.rootCustomCache) return this.rootCustomCache;
    const out: Cand[] = [];
    for (const r of this.s.rules) {
      for (const sel of r.selectors) {
        if (!/^(:root|html)$/i.test(sel.text.trim())) continue;
        let bps: Breakpoint[] | "always" | null;
        try { bps = this.registerBreakpoints(r, () => r.path); } catch { continue; }
        if (bps === null) continue;
        const alts = bps === "always" ? [[]] : bps.map((bp) => [`bp:${bp.name}`]);
        for (const d of r.decls) if (d.name.startsWith("--")) for (const dims of alts) {
          out.push({ prop: d.name, entry: { value: d.value, refs: varRefs(d.value) }, weight: d.important ? 4 : 2, spec: sel.specificity, order: r.index, dims, key: keyOf(dims) });
        }
      }
    }
    return (this.rootCustomCache = out);
  }

  /** Value of a custom property at element `i` in the layer context `ctx` (nearest ancestor-or-self definition active there). */
  private customAt(i: number, ctx: string[], name: string, depth = 0): string | undefined {
    if (depth > 32) return undefined;
    for (let a = i; a >= 0; a = this.parent(a)) {
      const pool: Cand[] = [];
      for (const c of this.cands(a)) {
        if (c.prop !== name) continue;
        const t = a === i ? c.dims : toDescendant(c.dims, this.id(a));
        if (t && subset(t, ctx)) pool.push(c);
      }
      if (pool.length) return resolveVars(winner(pool).entry.value, (n) => this.customAt(a, ctx, n, depth + 1)).trim();
    }
    const top = this.rootCustom().filter((c) => c.prop === name && subset(c.dims, ctx));
    if (top.length) return resolveVars(winner(top).entry.value, (n) => this.customAt(-1, ctx, n, depth + 1)).trim();
    return this.s.rootVars[name];
  }

  /** Layer contexts in which custom properties read from element `i` (directly or through other custom properties) are redefined. */
  private varContexts(i: number, names: string[]): string[][] {
    const want = new Set(names);
    const out = new Map<string, string[]>();
    for (let grew = true; grew;) {
      grew = false;
      const visit = (c: Cand, t: string[] | null) => {
        if (!want.has(c.prop)) return;
        for (const r of c.entry.refs) if (!want.has(r)) { want.add(r); grew = true; }
        if (t && t.length) out.set(keyOf(t), t);
      };
      for (let a = i; a >= 0; a = this.parent(a)) for (const c of this.cands(a)) if (c.prop.startsWith("--")) visit(c, a === i ? c.dims : toDescendant(c.dims, this.id(a)));
      for (const c of this.rootCustom()) visit(c, c.dims);
    }
    return Array.from(out.values());
  }

  /** `initial`, `inherit`, `unset`, `revert` as concrete values for layer `dims` (null: no value). */
  private keyword(i: number, dims: string[], prop: string, kw: string): string | null {
    const e = this.s.elements[i];
    if (kw === "revert" || kw === "revert-layer") {
      if (e.ua[prop]) return e.ua[prop].value;
      kw = "unset";
    }
    if (kw === "unset") kw = INHERITED.has(prop) ? "inherit" : "initial";
    if (kw === "initial") return INITIAL[prop] ?? null;
    // inherit: the parent's value in the same layer
    for (let a = this.parent(i); a >= 0; a = this.parent(a)) {
      const w = this.effective(a, toAncestor(dims, this.id(a)), prop);
      if (w) return w.entry.value;
      if (!INHERITED.has(prop)) break;
    }
    const p = e.parent >= 0 ? this.s.elements[e.parent] : null;
    const v = p?.computed[prop];
    return v ? (COLOR_PROPS.has(prop) ? normalizeColor(v) : v) : INITIAL[prop] ?? null;
  }

  /** Every declaration that can apply to element `i`, with its layer dimensions (custom properties raw). */
  cands(i: number): Cand[] {
    const hit = this.candCache.get(i);
    if (hit) return hit;
    const { s } = this;
    const e = s.elements[i];
    const out: Cand[] = [];
    this.candCache.set(i, out); // custom-property lookups on this element read the list as it grows
    const push = (prop: string, value: string, refs: string[], weight: number, spec: [number, number, number], order: number, dims: string[], base?: string) => {
      let v = value;
      const kw = v.trim().toLowerCase();
      if (CSS_WIDE.has(kw) && prop !== "all") {
        const r = this.keyword(i, dims, prop, kw);
        if (r === null) return;
        v = r;
      }
      if (COLOR_PROPS.has(prop)) v = normalizeColor(v);
      out.push({ prop, entry: { value: v, refs, base }, weight, spec, order, dims, key: keyOf(dims) });
    };
    // two passes: this element's custom properties first, so var() in any of its declarations sees all of them
    let customPass = true;
    const add = (d: SnapDecl, weight: number, spec: [number, number, number], order: number, dims: string[], base?: string) => {
      if (d.invalid) return;
      if (d.name.startsWith("--")) {
        if (customPass) out.push({ prop: d.name, entry: { value: d.value, refs: varRefs(d.value) }, weight, spec, order, dims, key: keyOf(dims) });
        return;
      }
      if (customPass) return;
      // a longhand the snapshot expanded from a shorthand that used var(): the shorthand is the source
      const colon = d.via ? d.via.indexOf(":") : -1;
      const via = colon > 0 ? { name: d.via!.slice(0, colon).trim(), value: d.via!.slice(colon + 1).trim() } : null;
      const refs = varRefs(via ? via.value : d.value);
      const first = remToPx(resolveVars(d.value, lookup(s, i)), s.rootFontSize);
      push(d.name, first, refs, weight, spec, order, dims, base);
      if (!refs.length) return;
      // custom properties redefined in a layer (on this element or an ancestor): the value in that layer
      for (const ctx of this.varContexts(i, refs)) {
        const u = union(dims, ctx);
        if (!satisfiable(u, this.breakpoints) || keyOf(u) === keyOf(dims)) continue;
        let v: string;
        if (via) {
          const sub = resolveVars(via.value, (n) => this.customAt(i, u, n));
          const key = expansionKey(via.name, sub);
          if (!this.ctx.expansions?.has(key)) { this.missingExpansions.set(key, { name: via.name, value: sub }); continue; }
          const long = this.ctx.expansions.get(key)?.find((x) => x.name === d.name);
          if (!long) continue;
          v = remToPx(long.value, s.rootFontSize);
        } else v = remToPx(resolveVars(d.value, (n) => this.customAt(i, u, n)), s.rootFontSize);
        if (v !== first) push(d.name, v, refs, weight, spec, order, u, base);
      }
    };
    const ruleAlts = new Map<SnapSelector, string[][] | null>();
    const altsOf = (sel: SnapSelector, rule: SnapRule) => {
      if (!ruleAlts.has(sel)) ruleAlts.set(sel, this.selectorDims(sel, rule, i));
      return ruleAlts.get(sel)!;
    };
    for (const pass of [true, false]) {
      customPass = pass;
      if (!pass) for (const [prop, ua] of Object.entries(e.ua)) if (uaRenders(e, prop)) push(prop, ua.value, [], 0, [0, 0, 0], -2, []);
      for (const d of this.ctx.presentational?.get(i) ?? []) {
        const value = /^(width|height)$/.test(d.name) && /^\d+(\.\d+)?$/.test(d.value.trim()) ? `${d.value.trim()}px` : d.value;
        add({ ...d, value }, 1, [0, 0, 0], -1, [], this.ctx.docUrl);
      }
      for (const src of sourcesOf(s)[i] ?? []) {
        if (src.kind === "inline") {
          for (const d of src.decls) add(d, d.important ? 5 : 3, [0, 0, 0], Number.MAX_SAFE_INTEGER, [], this.ctx.docUrl);
          continue;
        }
        const rule = src.rule!;
        for (const sel of rule.selectors) {
          if (sel.pseudoElement || !this.reaches(sel, i)) continue;
          const alts = altsOf(sel, rule);
          if (!alts) continue;
          for (const dims of alts) for (const d of declsAt(src, i)) add(d, d.important ? 4 : 2, sel.specificity, rule.index, dims, sheetUrl(rule.sheet, this.ctx.docUrl));
        }
      }
    }
    return out;
  }

  /** Candidates per property (custom properties excluded; `all` expanded over the element's other properties). */
  private byProp(i: number): Map<string, Cand[]> {
    const hit = this.propCache.get(i);
    if (hit) return hit;
    const cs = this.cands(i);
    const props = new Set(cs.filter((c) => c.prop !== "all" && !c.prop.startsWith("--")).map((c) => c.prop));
    const out = new Map<string, Cand[]>();
    const put = (c: Cand) => out.set(c.prop, [...(out.get(c.prop) ?? []), c]);
    for (const c of cs) {
      if (c.prop.startsWith("--")) continue;
      if (c.prop !== "all") { put(c); continue; }
      for (const p of props) {
        const kw = c.entry.value.trim().toLowerCase();
        const v = CSS_WIDE.has(kw) ? this.keyword(i, c.dims, p, kw) : null;
        if (v !== null) put({ ...c, prop: p, entry: { ...c.entry, value: COLOR_PROPS.has(p) ? normalizeColor(v) : v } });
      }
    }
    this.propCache.set(i, out);
    return out;
  }

  /** The declaration that wins for `prop` at element `i` when exactly the layer dimensions `dims` hold. */
  effective(i: number, dims: readonly string[], prop: string): Cand | null {
    const pool = (this.byProp(i).get(prop) ?? []).filter((c) => subset(c.dims, dims));
    return pool.length ? winner(pool) : null;
  }

  /** Same, without the layer `dims` itself (what holds underneath it). */
  private below(i: number, dims: readonly string[], prop: string): Cand | null {
    const key = keyOf(dims);
    const pool = (this.byProp(i).get(prop) ?? []).filter((c) => c.key !== key && subset(c.dims, dims));
    return pool.length ? winner(pool) : null;
  }

  /** Recorded layers: base winners, each layer's own winners, and unions of co-active layers that set one property. */
  raw(i: number): Layers {
    const hit = this.rawCache.get(i);
    if (hit) return hit;
    const out: Layers = new Map([["base", new Map()]]);
    const set = (key: string, prop: string, en: Entry) => { if (!out.has(key)) out.set(key, new Map()); out.get(key)!.set(prop, en); };
    for (const [prop, list] of this.byProp(i)) {
      const base = list.filter((c) => !c.dims.length);
      if (base.length) set("base", prop, winner(base).entry);
      const layered = new Map<string, string[]>();
      for (const c of list) if (c.dims.length) layered.set(c.key, c.dims);
      const universe = new Map(layered);
      for (const u of unions(Array.from(layered.values()), this.breakpoints)) if (!universe.has(keyOf(u))) universe.set(keyOf(u), u);
      for (const [key, dims] of universe) {
        const pool = list.filter((c) => subset(c.dims, dims));
        const sources = new Set(pool.filter((c) => c.dims.length).map((c) => c.key));
        if (!sources.size) continue;
        const w = winner(pool);
        if (sources.size > 1 || w.key === key) set(key, prop, w.entry);
      }
    }
    this.rawCache.set(i, out);
    return out;
  }

  /** Element needs per-layer boxes: border radii or a transform (resolved against the layer's box). */
  needsBoxes(i: number): boolean {
    return Array.from(this.byProp(i).keys()).some((p) => RADII.includes(p) || p === "transform");
  }

  private box(key: string, i: number): Size | null {
    return this.ctx.boxes?.get(key)?.get(i) ?? this.baseBox(i);
  }

  /** Untransformed border box in the default state (else the first layer that shows the element), or null. */
  baseBox(i: number): Size | null {
    const e = this.s.elements[i];
    if (e.size) return e.size;
    for (const k of Array.from(this.ctx.boxes?.keys() ?? []).sort()) { const b = this.ctx.boxes!.get(k)!.get(i); if (b) return b; }
    return null;
  }

  /** Style layers as the IR records them; display always set in base. */
  layers(i: number): Layers {
    const hit = this.doneCache.get(i);
    if (hit) return hit;
    const { s } = this;
    const e = s.elements[i];
    const out: Layers = new Map();
    for (const [name, m] of this.raw(i)) {
      const l: Layer = new Map();
      for (const [p, en] of m) {
        if (isAnimProperty(p) || NO_EFFECT.has(p)) continue;
        if (cssSupport.omittedAtExport(p, en.value)) continue; // shorthand residue, initial values of properties the mapper rejects
        l.set(p, en);
      }
      out.set(name, l);
    }
    const base = out.get("base")!;
    const eff = (dims: readonly string[], p: string) => this.effective(i, dims, p)?.entry.value;
    const colorAt = (dims: readonly string[]) => eff(dims, "color") ?? normalizeColor(e.computed.color ?? "");

    // borders as they render: no style → no border; width keywords → px; currentcolor → the element's colour
    const visible = (st: string | undefined) => st !== undefined && !/^(none|hidden|initial)$/.test(st);
    for (const side of SIDES) {
      const W = `border-${side}-width`, S = `border-${side}-style`, C = `border-${side}-color`;
      const fix = (layer: Layer, dims: readonly string[]) => {
        const w = layer.get(W);
        if (w && WIDTH_KEYWORDS[w.value]) layer.set(W, { ...w, value: WIDTH_KEYWORDS[w.value] });
        const c = layer.get(C);
        if (c && c.value === "currentcolor") layer.set(C, { ...c, value: colorAt(dims) });
      };
      if (visible(eff([], S))) {
        if (!base.has(W)) base.set(W, { value: eff([], W) ?? "medium", refs: [] });
        fix(base, []);
      } else { base.delete(W); base.delete(S); base.delete(C); }
      for (const [name, layer] of out) {
        if (name === "base" || ![W, S, C].some((k) => layer.has(k))) continue;
        const dims = dimsOf(name);
        const below = visible(this.below(i, dims, S)?.entry.value);
        if (!visible(eff(dims, S))) {
          layer.delete(C);
          if (below) layer.set(W, { value: "0px", refs: [] }); else layer.delete(W);
          if (!below) layer.delete(S);
          continue;
        }
        if (!below) {
          if (!layer.has(W)) layer.set(W, { value: eff(dims, W) ?? "medium", refs: [] });
          const c = eff(dims, C);
          if (!layer.has(C) && c) layer.set(C, { value: c, refs: [] });
          if (!layer.has(S)) layer.set(S, { value: eff(dims, S)!, refs: [] });
        }
        fix(layer, dims);
      }
    }

    // text-shadow: the one shadow USS draws, as "x y blur colour" (lint U-CSS-023 rejects a list)
    for (const [name, layer] of out) {
      const en = layer.get("text-shadow");
      if (en) layer.set("text-shadow", { ...en, value: normalizeTextShadow(en.value, null, { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize }, e.path) });
    }

    // transform → translate / rotate / scale, against the layer's box
    if (Array.from(out.values()).some((m) => m.has("transform"))) {
      if (["translate", "rotate", "scale"].some((p) => (this.byProp(i).get(p) ?? []).some((c) => c.entry.value.trim() !== "none"))) {
        throw new Error(`${e.path}: transform together with translate/rotate/scale cannot be split into the IR's translate, rotate and scale; use one of the two forms`);
      }
      const lctx = { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize };
      const split = (v: string | undefined, box: Size | null): TransformSplit => {
        if (v === undefined) return NONE_SPLIT;
        const r = splitTransform(CSS_WIDE.has(v.trim()) ? "none" : v, box ?? undefined, lctx);
        if (!r.ok) throw new Error(`${e.path}: transform: ${v}: ${r.reason}`);
        return r.split;
      };
      for (const [name, layer] of out) {
        const en = layer.get("transform");
        if (!en) continue;
        layer.delete("transform");
        const dims = dimsOf(name);
        const vals = transformValues(split(en.value, this.box(name, i)));
        const under = transformValues(name === "base" ? NONE_SPLIT : split(this.below(i, dims, "transform")?.entry.value, this.box(name, i)));
        for (const k of ["translate", "rotate", "scale"] as const) {
          if (vals[k] !== null) layer.set(k, { value: vals[k]!, refs: en.refs });
          else if (under[k] !== null) layer.set(k, { value: "none", refs: [] });
        }
      }
    }

    // border radii → one px value per corner for the layer's box (findings R1, overlapping-curves rule)
    if (RADII.some((p) => this.byProp(i).has(p))) {
      const lctx = { fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize };
      const resolveAt = (dims: readonly string[], box: Size | null) => {
        const corners: Partial<Record<Corner, string>> = {};
        for (const c of CORNERS) { const v = eff(dims, cornerProperty(c)); if (v !== undefined) corners[c] = v; }
        return box ? resolveRadii(corners, box, lctx) : null;
      };
      const rBase = resolveAt([], this.baseBox(i));
      for (const [name, layer] of out) {
        if (name === "base") {
          if (rBase) for (const c of CORNERS) { const k = cornerProperty(c); if (layer.has(k)) layer.set(k, { ...layer.get(k)!, value: `${fmt(rBase[c].x)}px` }); }
          continue;
        }
        const box = this.box(name, i);
        const r = resolveAt(dimsOf(name), box);
        if (!r) continue;
        for (const c of CORNERS) {
          const k = cornerProperty(c);
          if (layer.has(k) || (rBase && Math.abs(rBase[c].x - r[c].x) > 1e-6)) layer.set(k, { value: `${fmt(r[c].x)}px`, refs: layer.get(k)?.refs ?? [] });
        }
      }
      // a layer that only changes the box (state, breakpoint) still changes resolved % radii
      for (const key of this.ctx.boxes?.keys() ?? []) {
        if (out.has(key) || !rBase || !this.ctx.boxes!.get(key)!.has(i)) continue;
        const r = resolveAt(dimsOf(key), this.box(key, i));
        if (!r) continue;
        const diff = CORNERS.filter((c) => Math.abs(rBase[c].x - r[c].x) > 1e-6);
        if (diff.length) out.set(key, new Map(diff.map((c) => [cornerProperty(c), { value: `${fmt(r[c].x)}px`, refs: [] }])));
      }
    }

    // presentational aspect-ratio ("auto 64 / 32"): the ratio, and only when it can size the element
    const ar = base.get("aspect-ratio");
    const arm = ar && /^auto\s+(.+)$/.exec(ar.value.trim());
    if (arm) {
      const sized = (k: string) => base.has(k) && base.get(k)!.value !== "auto";
      if (sized("width") && sized("height")) base.delete("aspect-ratio"); else base.set("aspect-ratio", { ...ar!, value: arm[1] });
    }

    // display, blockified like CSS in every layer (flex item or absolute); explicit in base (default state). The only
    // content of a block container, an inline element holding text, lays out like a block (lint U-CSS-009 rejects one
    // that draws an inline box, an atomic inline box and an inline holding blocks)
    const parent = e.parent >= 0 ? s.elements[e.parent] : null;
    const lone = !!parent && parent.texts.length === 0 && designChildren(s, parent).length === 1 && isTextElement(s, e);
    const blockify = (d: string) => ((parent && /flex/.test(parent.computed.display)) || e.computed.position === "absolute"
      ? ({ inline: "block", "inline-block": "block", "inline-flex": "flex", "list-item": "block" } as Record<string, string>)[d] ?? d
      : d === "list-item" || (d === "inline" && lone) ? "block" : d);
    for (const [name, layer] of out) {
      const d = layer.get("display");
      if (d) layer.set("display", { ...d, value: blockify(d.value.trim()) });
      else if (name === "base") layer.set("display", { value: blockify(e.computed.display ?? "block"), refs: [] });
    }

    // CSS initial values that render differently from USS's (findings O-6)
    const c = e.computed;
    const anyLayer = (p: string, test: (v: string) => boolean) => Array.from(out.values()).some((m) => m.has(p) && test(m.get(p)!.value));
    if (!base.has("position") && Array.from(out.values()).some((m) => INSETS.some((k) => m.has(k)))) base.set("position", { value: c.position || "static", refs: [] });
    if (!base.has("flex-direction") && anyLayer("display", (v) => /flex/.test(v))) base.set("flex-direction", { value: "row", refs: [] });
    if (!base.has("align-content") && anyLayer("flex-wrap", (v) => v !== "nowrap")) base.set("align-content", { value: "stretch", refs: [] });
    const sized = ["width", "height"].some((k) => base.has(k) && base.get(k)!.value !== "auto");
    const extras = SIDES.some((sd) => (px(c[`padding-${sd}`]) ?? 0) !== 0 || (px(c[`border-${sd}-width`]) ?? 0) !== 0);
    if (!base.has("box-sizing") && c["box-sizing"] === "content-box" && sized && extras) base.set("box-sizing", { value: "content-box", refs: [] });

    for (const [name, layer] of out) if (name !== "base" && layer.size === 0) out.delete(name);
    this.doneCache.set(i, out);
    return out;
  }

  /**
   * Adds inherited properties to a node's layers: the nearest ancestor's base value (computed for colour and
   * font when nobody declares them), and every ancestor layer that changes them, as the matching layer seen from this
   * node (`anc(<id>):hover`, `state:x`, …) plus unions where layers meet. Returns where each layer came from, so the
   * ancestor's animations of those properties can be copied.
   */
  addInherited(i: number, layers: Layers, props: readonly string[]): InheritCopy[] {
    const { s } = this;
    const e = s.elements[i];
    const base = layers.get("base")!;
    const copies: InheritCopy[] = [];
    for (const p of props) {
      const own = this.byProp(i).get(p) ?? [];
      if (own.some((c) => !c.dims.length)) continue; // declared here: nothing inherited
      const sources: { dims: string[]; from: number; fromKey: string }[] = [];
      let baseFrom = -1;
      for (let a = e.parent; a >= 0; a = s.elements[a].parent) {
        const la = this.layers(a);
        for (const [key, m] of la) {
          if (key === "base" || !m.has(p)) continue;
          const t = toDescendant(dimsOf(key), this.id(a));
          if (t && satisfiable(t, this.breakpoints)) sources.push({ dims: t, from: a, fromKey: key });
        }
        if (la.get("base")!.has(p)) { baseFrom = a; break; }
      }
      const relative = (v: string) => (p === "font-size" && /(%|em)$|^(larger|smaller)$/.test(v)) || (p === "font-weight" && /^(bolder|lighter)$/.test(v));
      let baseVal: Entry | null = baseFrom >= 0 ? this.layers(baseFrom).get("base")!.get(p)! : null;
      const computed = e.computed[p];
      if ((!baseVal || relative(baseVal.value)) && ALWAYS.has(p) && computed) baseVal = { value: p === "color" ? normalizeColor(computed) : computed, refs: [] };
      if (baseVal && relative(baseVal.value)) baseVal = null;
      if (baseVal) { base.set(p, baseVal); if (baseFrom >= 0) copies.push({ prop: p, from: baseFrom, fromKey: "base", key: "base" }); }
      // the value where a set of layers holds: this node's own declaration, else the nearest ancestor's
      const valueAt = (dims: string[]): Entry | null => {
        const mine = own.filter((c) => subset(c.dims, dims));
        if (mine.length) return winner(mine).entry;
        for (let a = e.parent; a >= 0; a = s.elements[a].parent) {
          const pool = (this.byProp(a).get(p) ?? []).filter((c) => { const t = toDescendant(c.dims, this.id(a)); return !!t && subset(t, dims); });
          if (pool.length) { const v = winner(pool).entry; return relative(v.value) ? null : v; }
        }
        return baseVal;
      };
      const ownKeys = Array.from(new Set(own.map((c) => c.key))).map(dimsOf);
      const singles = new Map(sources.map((x) => [keyOf(x.dims), x]));
      const contexts = new Map<string, { dims: string[]; union: boolean }>();
      for (const x of sources) contexts.set(keyOf(x.dims), { dims: x.dims, union: false });
      for (const u of unions([...sources.map((x) => x.dims), ...ownKeys], this.breakpoints)) {
        const k = keyOf(u);
        if (!contexts.has(k) && ![...sources.map((x) => x.dims), ...ownKeys].some((d) => keyOf(d) === k)) contexts.set(k, { dims: u, union: true });
      }
      for (const [key, ctx] of contexts) {
        if (layers.get(key)?.has(p)) continue;
        const v = valueAt(ctx.dims);
        if (!v || (!ctx.union && v.value === baseVal?.value)) continue;
        if (!layers.has(key)) layers.set(key, new Map());
        layers.get(key)!.set(p, v);
        const src = singles.get(key);
        if (src) copies.push({ prop: p, from: src.from, fromKey: src.fromKey, key });
      }
    }
    return copies;
  }
}

export function toStyleLayers(layers: Layers): StyleLayers {
  const out: StyleLayers = {};
  for (const [name, m] of layers) out[name] = Object.fromEntries(Array.from(m, ([p, en]) => [p, en.value]));
  return out;
}

/** Specified style layers of one element (no presentational attributes, ids or layer boxes unless given). */
export function specifiedLayers(el: SnapElement, s: DomSnapshot, ctx: StyleContext = {}): StyleLayers {
  return toStyleLayers(new StyleExtractor(s, ctx).layers(el.index));
}

/** Comma list items of a property value (top level). */
export { splitTopLevel } from "../lint/css-values.js";
