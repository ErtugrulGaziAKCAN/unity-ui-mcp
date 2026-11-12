import type { CDPSession, Page } from "playwright";
import type { KitConfig } from "../kit.js";
import { declaredFontFaces, DESIGN_ORIGIN, KIT_PREFIX, STATIC_CSS, type DeclaredFontFace } from "../load.js";
import { declsOf, px, resolveVars, type SnapDecl } from "./css-values.js";
import { parseSelectorList, pseudoElement, reachSelector, specificity, structural, pseudoClasses } from "./selectors.js";
import { matchRichStyle, matchTextStyle, readTextStyles } from "./text-styles.js";

export type { SnapDecl } from "./css-values.js";

export interface Box { x: number; y: number; w: number; h: number }
export interface PlatformFont { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }

export interface SnapElement {
  /** Position in `elements` (document order: body, then its descendants). */
  index: number;
  /** localName (case kept for SVG). */
  tag: string;
  ns: "html" | "svg" | "math";
  attrs: Record<string, string>;
  parent: number;
  children: number[];
  /** CSS-like path: `[data-u-screen=inbox] > div:2 > button[data-u-id=open]` (index = position among element siblings). */
  path: string;
  nodeId: number;
  backendNodeId: number;
  /** Direct child text nodes with non-whitespace content, as in the DOM. */
  texts: string[];
  /** CDP CSS.getPlatformFontsForNode per entry of `texts` (null when not rendered). */
  textFonts: (PlatformFont[] | null)[];
  /** Has a layout box. */
  rendered: boolean;
  /** Border box from getBoundingClientRect (CSS px), null when not rendered. */
  box: Box | null;
  /** Computed values of SNAP_COMPUTED. Verification only; compilation uses specified values. */
  computed: Record<string, string>;
  /** Computed ::before/::after with content other than none/normal, and ::placeholder for elements with a placeholder. */
  pseudo: Partial<Record<"before" | "after" | "placeholder", Record<string, string>>>;
  /** Declarations of the style attribute (var() unresolved), or null without one. */
  inline: SnapDecl[] | null;
  /** Referenced custom properties whose computed value differs from the parent's (body: from the root). */
  vars: Record<string, string>;
  /** U-CSS-019 relayout: flex item whose main-axis min size is `auto`, box before and with that min size set to 0. */
  minAuto: { axis: "row" | "column"; before: Box; after: Box } | null;
  /** Kit text style the element's text matches (set when collectSnapshot gets the kit); null = no match, undefined = no text. */
  textStyle?: string | null;
}

export interface SnapSelector {
  text: string;
  /** Selector used to find the elements this rule reaches in any interaction or screen state. */
  reach: string;
  specificity: [number, number, number];
  pseudoClasses: string[];
  pseudoElement: string | null;
  structural: string[];
  /** Indices of the elements `reach` matches (null when it is not a valid selector for the browser). */
  elements: number[] | null;
}

export interface SnapRule {
  /** Cascade order over all sheets. */
  index: number;
  sheet: string;
  kit: boolean;
  selectorText: string;
  selectors: SnapSelector[];
  /** Enclosing @media conditions, outermost first (including sheet and @import media). */
  media: string[];
  /** Every enclosing condition (@media, @supports, @layer, @container, …), outermost first. */
  conditions: string[];
  /** CSSOM longhands, plus shorthands pending var() substitution expanded with the values at `varsFrom`. */
  decls: SnapDecl[];
  path: string;
}

export interface SnapMedia { sheet: string; kit: boolean; condition: string; source: "rule" | "import" | "sheet"; path: string }
export interface SnapKeyframes { sheet: string; kit: boolean; name: string; path: string; frames: { key: string; decls: SnapDecl[] }[] }
export interface SnapSheet { label: string; href: string | null; kit: boolean; media: string }

export interface DomSnapshot {
  viewport: { width: number; height: number; scale: number };
  elements: SnapElement[];
  rules: SnapRule[];
  media: SnapMedia[];
  keyframes: SnapKeyframes[];
  sheets: SnapSheet[];
  /** At-rules without style content the walk does not model (@property, @page, …), for reporting. */
  otherAtRules: { sheet: string; text: string }[];
  fontFaces: DeclaredFontFace[];
  /** Referenced custom properties on the root element. */
  rootVars: Record<string, string>;
  timings: Record<string, number>;
}

/** Computed properties recorded per element. Extend here when a rule or the exporter needs more. */
export const SNAP_COMPUTED = [
  "display", "position", "float", "z-index", "flex-direction", "flex-wrap", "row-gap", "column-gap", "align-items", "align-self",
  "justify-content", "min-width", "min-height", "width", "height", "overflow-x", "overflow-y", "visibility", "opacity",
  "font-family", "font-size", "line-height", "font-weight", "font-style", "font-variant-caps", "letter-spacing", "word-spacing",
  "text-transform", "text-shadow", "text-align", "list-style-type", "list-style-image", "white-space-collapse", "text-wrap-mode", "text-decoration-line", "vertical-align",
  "color", "background-color", "background-image", "box-shadow", "filter", "backdrop-filter", "transform", "outline-style",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
] as const;

const PSEUDO_PROPS = ["content", "display", "font-family", "font-size", "line-height", "font-weight", "color"];
const NO_TEXT_TAGS = new Set(["script", "style", "template", "noscript", "title"]);

interface RawStyle { longhands: SnapDecl[]; cssText: string }
interface RawRule extends RawStyle { index: number; sheet: string; kit: boolean; selectorText: string; media: string[]; conditions: string[] }
interface RawElement {
  tag: string; ns: string; attrs: Record<string, string>; parent: number; texts: string[]; rendered: boolean; box: Box | null;
  computed: Record<string, string>; pseudo: Record<string, Record<string, string>>; inline: RawStyle | null; vars: Record<string, string>;
  minAuto: { axis: "row" | "column"; before: Box; after: Box } | null;
}
interface RawPage {
  viewport: { width: number; height: number; scale: number };
  sheets: SnapSheet[]; rules: RawRule[]; media: Omit<SnapMedia, "path">[]; otherAtRules: { sheet: string; text: string }[];
  keyframes: { sheet: string; kit: boolean; name: string; frames: { key: string; longhands: SnapDecl[] }[] }[];
  elements: RawElement[]; rootVars: Record<string, string>;
}

/** Runs in the page: sheets, rules, keyframes, elements with computed styles, and the U-CSS-019 relayout. */
function pageCollect(arg: { props: string[]; pseudoProps: string[]; staticCss: string; kitBase: string; origin: string }): RawPage {
  const isFreeze = (n: Node | null) => !!n && (n as Element).localName === "style" && (n.textContent ?? "").trim() === arg.staticCss;
  const styleEls = Array.from(document.querySelectorAll("style")).filter((s) => !isFreeze(s));
  const out: RawPage = {
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    sheets: [], rules: [], media: [], otherAtRules: [], keyframes: [], elements: [], rootVars: {},
  };
  const label = (sheet: CSSStyleSheet): string => {
    const own = sheet.ownerNode as Element | null;
    if (own && own.localName === "style") return `style:${styleEls.indexOf(own as HTMLStyleElement)}`;
    const href = sheet.href ?? "";
    if (href.startsWith(arg.kitBase)) return `kit:${decodeURIComponent(href.slice(arg.kitBase.length))}`;
    if (href.startsWith(arg.origin + "/")) return decodeURIComponent(href.slice(arg.origin.length + 1));
    return href || "sheet";
  };
  const longhands = (st: CSSStyleDeclaration): SnapDecl[] => {
    const r: SnapDecl[] = [];
    for (let i = 0; i < st.length; i++) r.push({ name: st[i], value: st.getPropertyValue(st[i]), important: st.getPropertyPriority(st[i]) === "important" });
    return r;
  };
  let ruleIndex = 0;
  const walk = (list: CSSRuleList, lab: string, kit: boolean, media: string[], conds: string[], parentSel: string | null): void => {
    for (const r of Array.from(list)) {
      const ctor = r.constructor.name;
      if (r instanceof CSSStyleRule || ctor === "CSSNestedDeclarations") {
        const raw = r instanceof CSSStyleRule ? r.selectorText : "&";
        const sel = parentSel === null ? raw : raw.includes("&") ? raw.split("&").join(`:is(${parentSel})`) : `:is(${parentSel}) ${raw}`;
        const st = (r as CSSStyleRule).style;
        out.rules.push({ index: ruleIndex++, sheet: lab, kit, selectorText: sel, media, conditions: conds, longhands: longhands(st), cssText: st.cssText });
        if (r instanceof CSSStyleRule && r.cssRules && r.cssRules.length) walk(r.cssRules, lab, kit, media, conds, sel);
      } else if (r instanceof CSSMediaRule) {
        out.media.push({ sheet: lab, kit, condition: r.media.mediaText, source: "rule" });
        walk(r.cssRules, lab, kit, [...media, r.media.mediaText], [...conds, `@media ${r.media.mediaText}`], parentSel);
      } else if (r instanceof CSSImportRule) {
        const m = r.media.mediaText;
        if (m) out.media.push({ sheet: lab, kit, condition: m, source: "import" });
        if (r.styleSheet) sheet(r.styleSheet, m ? [...media, m] : media, m ? [...conds, `@import ${m}`] : conds);
      } else if (r instanceof CSSKeyframesRule) {
        out.keyframes.push({ sheet: lab, kit, name: r.name, frames: Array.from(r.cssRules).map((k) => ({ key: (k as CSSKeyframeRule).keyText, longhands: longhands((k as CSSKeyframeRule).style) })) });
      } else if (r instanceof CSSFontFaceRule) {
        // reported by declaredFontFaces
      } else if ("cssRules" in r) {
        const head = r.cssText.slice(0, r.cssText.indexOf("{")).trim();
        walk((r as CSSGroupingRule).cssRules, lab, kit, media, [...conds, head], parentSel);
      } else out.otherAtRules.push({ sheet: lab, text: r.cssText.slice(0, 160) });
    }
  };
  const sheet = (s: CSSStyleSheet, media: string[], conds: string[]): void => {
    if (isFreeze(s.ownerNode)) return;
    let rules: CSSRuleList;
    try { rules = s.cssRules; } catch { return; }
    const lab = label(s), kit = (s.href ?? "").startsWith(arg.kitBase), m = s.media.mediaText;
    out.sheets.push({ label: lab, href: s.href, kit, media: m });
    if (m && !s.ownerRule) out.media.push({ sheet: lab, kit, condition: m, source: "sheet" });
    walk(rules, lab, kit, m && !s.ownerRule ? [...media, m] : media, m && !s.ownerRule ? [...conds, `@media ${m}`] : conds, null);
  };
  for (const s of Array.from(document.styleSheets)) sheet(s, [], []);

  // custom properties referenced anywhere
  const names = new Set<string>();
  const scan = (v: string) => { for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) names.add(m[1]); };
  for (const r of out.rules) { scan(r.cssText); r.longhands.forEach((l) => scan(l.value)); }
  for (const k of out.keyframes) k.frames.forEach((f) => f.longhands.forEach((l) => scan(l.value)));
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  for (const el of els) { const s = el.getAttribute("style"); if (s) scan(s); }
  const varNames = Array.from(names);
  const rootCs = getComputedStyle(document.documentElement);
  for (const n of varNames) out.rootVars[n] = rootCs.getPropertyValue(n);

  const idx = new Map<Element, number>(els.map((e, i) => [e, i]));
  const allVals: Record<string, string>[] = [];
  const rect = (el: Element): Box => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  els.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const computed: Record<string, string> = {};
    for (const p of arg.props) computed[p] = cs.getPropertyValue(p);
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    const texts: string[] = [];
    for (const c of Array.from(el.childNodes)) if (c.nodeType === 3 && /\S/.test((c as Text).data)) texts.push((c as Text).data);
    const rendered = el.getClientRects().length > 0;
    const pseudo: Record<string, Record<string, string>> = {};
    for (const p of ["before", "after"]) {
      const pcs = getComputedStyle(el, `::${p}`);
      if (pcs.content && pcs.content !== "none" && pcs.content !== "normal") {
        pseudo[p] = {};
        for (const q of arg.pseudoProps) pseudo[p][q] = pcs.getPropertyValue(q);
      }
    }
    if (el.hasAttribute("placeholder")) {
      const pcs = getComputedStyle(el, "::placeholder");
      pseudo.placeholder = {};
      for (const q of arg.pseudoProps) pseudo.placeholder[q] = pcs.getPropertyValue(q);
    }
    const own = (el as HTMLElement).style;
    const inline = el.hasAttribute("style") && own ? { longhands: longhands(own), cssText: own.cssText } : null;
    const vals: Record<string, string> = {};
    for (const n of varNames) vals[n] = cs.getPropertyValue(n);
    allVals.push(vals);
    const parentIdx = i === 0 ? -1 : idx.get(el.parentElement as Element) ?? -1;
    const base = parentIdx < 0 ? out.rootVars : allVals[parentIdx];
    const vars: Record<string, string> = {};
    for (const n of varNames) if (vals[n] !== base[n]) vars[n] = vals[n];
    const ns = el.namespaceURI === "http://www.w3.org/2000/svg" ? "svg" : el.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? "math" : "html";
    out.elements.push({ tag: el.localName, ns, attrs, parent: parentIdx, texts, rendered, box: rendered ? rect(el) : null, computed, pseudo, inline, vars, minAuto: null });
  });

  // U-CSS-019: one relayout with the main-axis min size of every `auto` flex item set to 0
  const cands: { i: number; el: Element; axis: "row" | "column"; before: Box; attr: string }[] = [];
  els.forEach((el, i) => {
    const e = out.elements[i];
    if (i === 0 || !e.rendered || e.computed.position === "absolute" || e.computed.position === "fixed") return;
    let lp = el.parentElement;
    while (lp && getComputedStyle(lp).display === "contents") lp = lp.parentElement;
    if (!lp) return;
    const pcs = getComputedStyle(lp);
    if (pcs.display !== "flex" && pcs.display !== "inline-flex") return;
    const axis = pcs.flexDirection.startsWith("column") ? "column" : "row";
    if (e.computed[axis === "row" ? "min-width" : "min-height"] !== "auto") return;
    cands.push({ i, el, axis, before: rect(el), attr: axis === "row" ? "data-ulint-min0w" : "data-ulint-min0h" });
  });
  if (cands.length) {
    const st = document.createElement("style");
    st.textContent = "[data-ulint-min0w]{min-width:0px!important}[data-ulint-min0h]{min-height:0px!important}";
    document.head.appendChild(st);
    for (const c of cands) c.el.setAttribute(c.attr, "");
    const after = cands.map((c) => rect(c.el));
    for (const c of cands) c.el.removeAttribute(c.attr);
    st.remove();
    void document.body.offsetHeight;
    cands.forEach((c, k) => { out.elements[c.i].minAuto = { axis: c.axis, before: c.before, after: after[k] }; });
  }
  return out;
}

/** Runs in the page: element indices each selector matches (null when the browser rejects the selector). */
function pageMatch(selectors: string[]): (number[] | null)[] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const idx = new Map<Element, number>(els.map((e, i) => [e, i]));
  return selectors.map((s) => {
    try {
      const r: number[] = [];
      for (const e of Array.from(document.querySelectorAll(s))) { const i = idx.get(e); if (i !== undefined) r.push(i); }
      return r;
    } catch { return null; }
  });
}

/** Runs in the page: CSSOM longhand expansion of shorthands whose var() references were substituted. */
function pageExpand(items: { name: string; value: string }[]): (SnapDecl[] | null)[] {
  return items.map(({ name, value }) => {
    const st = document.createElement("div").style;
    st.setProperty(name, value);
    if (st.length === 0) return null;
    const r: SnapDecl[] = [];
    for (let i = 0; i < st.length; i++) r.push({ name: st[i], value: st.getPropertyValue(st[i]), important: false });
    return r;
  });
}

const quote = (v: string) => (/^[A-Za-z0-9._-]+$/.test(v) ? v : JSON.stringify(v));

function elementPaths(els: { tag: string; attrs: Record<string, string>; parent: number }[], children: number[][]): string[] {
  const paths: string[] = [];
  els.forEach((e, i) => {
    if (e.attrs["data-u-screen"] !== undefined) { paths.push(`[data-u-screen=${quote(e.attrs["data-u-screen"])}]`); return; }
    if (e.parent < 0) { paths.push(e.tag.toLowerCase()); return; }
    const id = e.attrs["data-u-id"];
    const seg = id !== undefined ? `${e.tag.toLowerCase()}[data-u-id=${quote(id)}]` : `${e.tag.toLowerCase()}:${children[e.parent].indexOf(i)}`;
    paths.push(`${paths[e.parent]} > ${seg}`);
  });
  return paths;
}

/** Calls the page function with a `__name` shim: tsx (esbuild keepNames) wraps inner functions with it. */
async function evaluate<A, R>(page: Page, fn: (a: A) => R, arg: A): Promise<R> {
  await page.evaluate("globalThis.__name ??= (f) => f");
  return page.evaluate(fn as unknown as (a: unknown) => R, arg as unknown) as Promise<R>;
}

/**
 * Collects everything lint and extraction read from a loaded design, once: DOM with computed styles and boxes,
 * every style rule with the elements it can reach, @media, @keyframes, font faces, the platform fonts that render
 * each text node, and the automatic-minimum-size relayout. Leaves the page as it was.
 */
export async function collectSnapshot(page: Page, cdp: CDPSession, kit?: KitConfig): Promise<DomSnapshot> {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => { const n = performance.now(); timings[k] = Math.round((n - t) * 10) / 10; t = n; };

  const raw = await evaluate(page, pageCollect, {
    props: [...SNAP_COMPUTED], pseudoProps: PSEUDO_PROPS, staticCss: STATIC_CSS, kitBase: DESIGN_ORIGIN + KIT_PREFIX, origin: DESIGN_ORIGIN,
  });
  lap("page");

  const children: number[][] = raw.elements.map(() => []);
  raw.elements.forEach((e, i) => { if (e.parent >= 0) children[e.parent].push(i); });
  const paths = elementPaths(raw.elements, children);

  // selectors → reach selectors, matched in one page call
  const parsed = raw.rules.map((r) => parseSelectorList(r.selectorText));
  const reach = new Map<string, number>();
  const reachOf = parsed.map((list) => list.map((p) => {
    const s = reachSelector(p);
    if (!reach.has(s)) reach.set(s, reach.size);
    return s;
  }));
  const matched = await evaluate(page, pageMatch, Array.from(reach.keys()));
  lap("match");

  // var() lookup per element (walks up to the root)
  const lookupAt = (i: number) => (name: string): string | undefined => {
    for (let k = i; k >= 0; k = raw.elements[k].parent) if (name in raw.elements[k].vars) return raw.elements[k].vars[name];
    return raw.rootVars[name];
  };
  // shorthands pending var() substitution: expand with the values at the first reached element (or the root)
  const pending: { name: string; value: string }[] = [];
  const pendingOf = (style: RawStyle, at: number) => {
    const decls = declsOf(style.longhands, style.cssText);
    const known = new Set(style.longhands.map((l) => l.name));
    return decls.map((d) => {
      if (known.has(d.name)) return { d, slot: -1 };
      pending.push({ name: d.name, value: resolveVars(d.value, lookupAt(at)) });
      return { d, slot: pending.length - 1 };
    });
  };
  const ruleDecls = raw.rules.map((r, k) => {
    const first = reachOf[k].map((s) => matched[reach.get(s)!] ?? []).flat().sort((a, b) => a - b)[0] ?? -1;
    return pendingOf(r, first);
  });
  const inlineDecls = raw.elements.map((e, i) => (e.inline ? pendingOf(e.inline, i) : null));
  const expanded = pending.length ? await evaluate(page, pageExpand, pending) : [];
  const finish = (list: { d: SnapDecl; slot: number }[]): SnapDecl[] => list.flatMap(({ d, slot }) => {
    if (slot < 0) return [d];
    const ex = expanded[slot];
    // invalid after substitution: keep the shorthand so rules can report it
    return ex ? ex.map((x) => ({ ...x, important: d.important, via: `${d.name}: ${d.value}` })) : [{ ...d, invalid: true }];
  });
  lap("expand");

  // CDP: node ids and the platform fonts that render every text node
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  type Node = { nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; localName?: string; nodeValue?: string; children?: Node[] };
  const findBody = (n: Node): Node | null => {
    if (n.nodeType === 1 && (n.localName ?? n.nodeName.toLowerCase()) === "body") return n;
    for (const c of n.children ?? []) { const b = findBody(c); if (b) return b; }
    return null;
  };
  const body = findBody(doc.root as Node);
  const cdpEls: { node: Node; texts: number[] }[] = [];
  const visit = (n: Node) => {
    cdpEls.push({ node: n, texts: (n.children ?? []).filter((c) => c.nodeType === 3 && /\S/.test(c.nodeValue ?? "")).map((c) => c.nodeId) });
    for (const c of n.children ?? []) if (c.nodeType === 1) visit(c);
  };
  if (body) visit(body);
  if (cdpEls.length !== raw.elements.length || cdpEls.some((c, i) => (c.node.localName ?? c.node.nodeName).toLowerCase() !== raw.elements[i].tag.toLowerCase())) {
    throw new Error("collectSnapshot: the DOM changed while it was being read");
  }
  const fontJobs: Promise<PlatformFont[] | null>[][] = cdpEls.map((c, i) => c.texts.map((id) => {
    if (!raw.elements[i].rendered || NO_TEXT_TAGS.has(raw.elements[i].tag.toLowerCase())) return Promise.resolve(null);
    return cdp.send("CSS.getPlatformFontsForNode", { nodeId: id }).then((r) => r.fonts as PlatformFont[], () => null);
  }));
  const textFonts = await Promise.all(fontJobs.map((j) => Promise.all(j)));
  lap("cdp");

  const fontFaces = await declaredFontFaces(page, kit);
  lap("fonts");

  const elements: SnapElement[] = raw.elements.map((e, i) => ({
    index: i, tag: e.tag, ns: e.ns as SnapElement["ns"], attrs: e.attrs, parent: e.parent, children: children[i], path: paths[i],
    nodeId: cdpEls[i].node.nodeId, backendNodeId: cdpEls[i].node.backendNodeId,
    texts: e.texts, textFonts: textFonts[i].length === e.texts.length ? textFonts[i] : e.texts.map(() => null),
    rendered: e.rendered, box: e.box, computed: e.computed, pseudo: e.pseudo, inline: inlineDecls[i] ? finish(inlineDecls[i]!) : null,
    vars: e.vars, minAuto: e.minAuto,
  }));
  const rules: SnapRule[] = raw.rules.map((r, k) => ({
    index: r.index, sheet: r.sheet, kit: r.kit, selectorText: r.selectorText, media: r.media, conditions: r.conditions,
    decls: finish(ruleDecls[k]), path: `${r.sheet} ${r.selectorText}`,
    selectors: parsed[k].map((p, j) => ({
      text: p.text, reach: reachOf[k][j], specificity: specificity(p), pseudoClasses: pseudoClasses(p), pseudoElement: pseudoElement(p),
      structural: structural(p), elements: matched[reach.get(reachOf[k][j])!],
    })),
  }));
  const s: DomSnapshot = {
    viewport: raw.viewport, elements, rules,
    media: raw.media.map((m) => ({ ...m, path: `${m.sheet} @media ${m.condition}` })),
    keyframes: raw.keyframes.map((k) => ({ sheet: k.sheet, kit: k.kit, name: k.name, path: `${k.sheet} @keyframes ${k.name}`, frames: k.frames.map((f) => ({ key: f.key, decls: f.longhands })) })),
    sheets: raw.sheets, otherAtRules: raw.otherAtRules, fontFaces, rootVars: raw.rootVars, timings,
  };
  if (kit) annotateTextStyles(s, kit);
  lap("finish");
  return s;
}

/** Elements that render text: direct text or a text control. */
export function rendersText(e: SnapElement): boolean {
  if (e.ns === "html" && NO_TEXT_TAGS.has(e.tag)) return false;
  if (e.texts.length > 0) return true;
  if (e.ns !== "html") return false;
  if (e.tag === "textarea" || e.tag === "select") return true;
  return e.tag === "input" && !/^(checkbox|radio|hidden|range|color|file|image|submit|reset|button)$/i.test(e.attrs.type ?? "text");
}

export const isInlineLevel = (e: SnapElement) => e.computed.display.startsWith("inline");

/** Sets `textStyle` on text elements: the full text style for blocks and controls, size + weight for inline rich text. */
export function annotateTextStyles(s: DomSnapshot, kit: KitConfig): void {
  const styles = readTextStyles(kit);
  for (const e of s.elements) {
    if (!rendersText(e)) continue;
    const size = px(e.computed["font-size"]), weight = Number(e.computed["font-weight"]);
    if (size === null) { e.textStyle = null; continue; }
    const m = isInlineLevel(e) && e.ns === "html" && e.texts.length > 0
      ? matchRichStyle(styles, size, weight)
      : matchTextStyle(styles, size, px(e.computed["line-height"]), weight);
    e.textStyle = m ? m.name : null;
  }
}
