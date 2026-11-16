import type { CDPSession, Page } from "playwright";
import type { KitConfig } from "../kit.js";
import { declaredFontFaces, DESIGN_ORIGIN, KIT_PREFIX, STATIC_CSS, type DeclaredFontFace } from "../load.js";
import { cssSupport } from "./allowed-css.js";
import { declsOf, px, resolveVars, type SnapDecl } from "./css-values.js";
import { parseSelectorList, pseudoElement, reachSelector, specificity, structural, pseudoClasses, type ParsedSelector } from "./selectors.js";
import { isKeyed, promotedRuns } from "./text-runs.js";
import { DYNAMIC_PSEUDO_CLASSES } from "./selectors.js";
import { matchRichStyle, matchTextStyle, readTextStyles } from "./text-styles.js";

export type { SnapDecl } from "./css-values.js";

export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface PlatformFont { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }

/** A keyed text's raw token as the page reports it (the shape `extract/text.ts` reads). */
export type EnTok = { text: string } | { br: true } | { arg: string; inner: EnTok[] };

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
  /** Border box from getBoundingClientRect (CSS px, transforms applied), null when not rendered. */
  box: Box | null;
  /** Untransformed border-box size (CSS px) for resolving %, radii, gradient lines; null when not rendered. */
  size: Size | null;
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
  /** The element hosts a shadow root (the walk does not enter it). */
  shadowRoot: "open" | "closed" | null;
  /**
   * Properties a browser-default (user-agent) rule sets and no author or inline declaration overrides, as physical
   * longhands with the element's and its parent's computed value. A lowest-priority source: U-CSS-026 judges it.
   */
  ua: Record<string, { value: string; parent: string }>;
  /** Kit text style the element's text matches (set when collectSnapshot gets the kit); null = no match, undefined = no text. */
  textStyle?: string | null;
  /**
   * On an element with `data-l10n` (not an input): its text as raw tokens (text, `<br>`, a `data-u-arg` span with its
   * sample text; children that do not render left out) and the browser's rendered text. The export's own text
   * normalization (`extract/text.ts`, `englishEntry`) turns them into the English entry the lint compares with `data-en`.
   */
  enToks?: EnTok[]; enRendered?: string | null;
  /**
   * On an element with `data-u-bind` or `data-u-arg`: its sample value as the IR's sample data reads it (`plainText`):
   * every descendant text node, a `<br>` as a line break, whatever CSS shows of it (visibility, text-transform, display:
   * a value that does not render, as in an inactive state root, has its text too); a field its `value` attribute, a
   * dropdown its selected option; "" without text (an `<img>`). The screen contract's sample check (U-CON-005)
   * compares it, normalized, with the contract's samples.
   */
  boundText?: string;
  /**
   * Inline <svg> roots: how its shapes paint. `current` = every fill/stroke/stop follows currentColor (tintable),
   * `fixed` = none does, `mixed` = both, `none` = nothing painted.
   */
  svgPaint?: "current" | "fixed" | "mixed" | "none";
  /**
   * The image the element draws: an `<img>`'s, else its first url() background image (`layer`: its index in the
   * background-image list); size in image pixels (for an `<img>` the file's own, whatever srcset density chose it) and
   * whether it is a raster image (not SVG). Undefined without one, or when it did not load within the snapshot's wait.
   */
  image?: SnapImage;
  /**
   * The element's own text lines, top to bottom (its text nodes and those of its inline descendants, not of a block or
   * inline-block inside it): each line's content-area extent from the text's client rects (CSS px, transforms applied,
   * as `box`). Undefined without direct text or when it is not rendered.
   */
  lines?: SnapLine[];
  /**
   * A wrapping text (text-wrap-mode wrap) whose characters reach past its content box: how far (CSS px) on the left and
   * the right, the word that reaches farthest, that word's width and the content box's width. The browser keeps a word that
   * has no break opportunity on its line and lets it overflow (W-TEXT-001). Undefined when nothing reaches past the box.
   */
  textOverflow?: { left: number; right: number; word: string; wordWidth: number; boxWidth: number };
}

/** One line of an element's text: its content-area extent (CSS px, page coordinates). */
export interface SnapLine { top: number; bottom: number; left: number; right: number }

export interface SnapImage { src: string; w: number; h: number; raster: boolean; layer?: number }

export interface SnapSelector {
  text: string;
  parsed: ParsedSelector;
  /** Selector used to find the elements this rule reaches in any interaction or screen state. */
  reach: string;
  specificity: [number, number, number];
  pseudoClasses: string[];
  pseudoElement: string | null;
  structural: string[];
  /** Indices of the elements `reach` matches (null when it is not a valid selector for the browser). */
  elements: number[] | null;
  /**
   * Compounds before the subject that carry an interaction pseudo-class or an is-* class, with the ancestors (inside
   * the screen root, the root included) of each reached element that can match them: the rule applies while such an
   * ancestor is in that state. A compound that is only such a state matches the ancestors carrying its is-* classes in
   * the markup; one that is only pseudo-classes names no ancestor (`bare`).
   */
  dynamicAncestors: { compound: number; matches: Record<number, number[]>; bare: boolean }[];
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
  /** CSSOM longhands, plus shorthands pending var() substitution expanded with the values at the first reached element. */
  decls: SnapDecl[];
  /** Elements whose var() values expand a pending shorthand differently from `decls`. */
  declsAt: Record<number, SnapDecl[]>;
  path: string;
}

export interface SnapMedia { sheet: string; kit: boolean; condition: string; source: "rule" | "import" | "sheet"; path: string }
export interface SnapKeyframes { sheet: string; kit: boolean; name: string; path: string; frames: { key: string; decls: SnapDecl[] }[] }
export interface SnapSheet { label: string; href: string | null; kit: boolean; media: string }
/** Every at-rule in every sheet (`kind` without "@": media, keyframes, import, font-face, layer, supports, …). */
export interface SnapAtRule { sheet: string; kit: boolean; kind: string; prelude: string; path: string }

export interface DomSnapshot {
  viewport: { width: number; height: number; scale: number };
  elements: SnapElement[];
  rules: SnapRule[];
  media: SnapMedia[];
  keyframes: SnapKeyframes[];
  sheets: SnapSheet[];
  atRules: SnapAtRule[];
  fontFaces: DeclaredFontFace[];
  /** Referenced custom properties on the root element. */
  rootVars: Record<string, string>;
  /** Computed font size of the root (html) element: the base of `rem`. */
  rootFontSize: number;
  timings: Record<string, number>;
}

/** Computed properties recorded per element. Extend here when a rule or the exporter needs more. */
export const SNAP_COMPUTED = [
  "display", "position", "float", "z-index", "flex-direction", "flex-wrap", "row-gap", "column-gap", "align-items", "align-self",
  "justify-content", "min-width", "min-height", "width", "height", "box-sizing", "overflow-x", "overflow-y", "visibility", "opacity",
  "font-family", "font-size", "line-height", "font-weight", "font-style", "font-variant-caps", "letter-spacing", "word-spacing",
  "text-transform", "text-shadow", "text-align", "list-style-type", "list-style-image", "white-space-collapse", "text-wrap-mode",
  "text-decoration-line", "vertical-align", "color", "background-color", "background-image", "box-shadow", "filter",
  "backdrop-filter", "transform", "translate", "rotate", "scale", "outline-style",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "-webkit-font-smoothing", "object-fit", "background-size",
] as const;

const PSEUDO_PROPS = ["content", "display", "font-family", "font-size", "line-height", "font-weight", "font-style", "color"];
const NO_TEXT_TAGS = new Set(["script", "style", "template", "noscript", "title"]);

interface RawStyle { longhands: SnapDecl[]; cssText: string }
interface RawRule extends RawStyle { index: number; sheet: string; kit: boolean; selectorText: string; media: string[]; conditions: string[] }
interface RawElement {
  tag: string; ns: string; attrs: Record<string, string>; parent: number; texts: string[]; rendered: boolean; box: Box | null;
  size: Size | null; computed: Record<string, string>; pseudo: Record<string, Record<string, string>>; inline: RawStyle | null;
  vars: Record<string, string>; minAuto: { axis: "row" | "column"; before: Box; after: Box } | null; shadow: boolean;
  lines?: SnapLine[]; textOverflow?: SnapElement["textOverflow"]; enToks?: EnTok[]; enRendered?: string | null;
  boundText?: string;
}
interface RawPage {
  viewport: { width: number; height: number; scale: number };
  sheets: SnapSheet[]; rules: RawRule[]; media: Omit<SnapMedia, "path">[]; atRules: Omit<SnapAtRule, "path">[];
  keyframes: { sheet: string; kit: boolean; name: string; frames: { key: string; longhands: SnapDecl[] }[] }[];
  elements: RawElement[]; rootVars: Record<string, string>; rootFontSize: string;
  svgPaint: Record<number, "current" | "fixed" | "mixed" | "none">;
}

/** Runs in the page: sheets (adopted ones too), rules, at-rules, keyframes, elements, and the U-CSS-019 relayout. */
function pageCollect(arg: { props: string[]; pseudoProps: string[]; staticCss: string; kitBase: string; origin: string }): RawPage {
  const isFreeze = (n: Node | null) => !!n && (n as Element).localName === "style" && (n.textContent ?? "").trim() === arg.staticCss;
  const styleEls = Array.from(document.querySelectorAll("style")).filter((s) => !isFreeze(s));
  const out: RawPage = {
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    sheets: [], rules: [], media: [], atRules: [], keyframes: [], elements: [], rootVars: {}, svgPaint: {},
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
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
  const at = (lab: string, kit: boolean, r: CSSRule) => {
    const text = r.cssText;
    const m = /^@([\w-]+)\s*([^{;]*)/.exec(text);
    if (m) out.atRules.push({ sheet: lab, kit, kind: m[1].toLowerCase(), prelude: m[2].trim() });
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
        continue;
      }
      at(lab, kit, r);
      if (r instanceof CSSMediaRule) {
        out.media.push({ sheet: lab, kit, condition: r.media.mediaText, source: "rule" });
        walk(r.cssRules, lab, kit, [...media, r.media.mediaText], [...conds, `@media ${r.media.mediaText}`], parentSel);
      } else if (r instanceof CSSImportRule) {
        const m = r.media.mediaText;
        if (m) out.media.push({ sheet: lab, kit, condition: m, source: "import" });
        if (r.styleSheet) sheet(r.styleSheet, m ? [...media, m] : media, m ? [...conds, `@import ${m}`] : conds);
      } else if (r instanceof CSSKeyframesRule) {
        out.keyframes.push({ sheet: lab, kit, name: r.name, frames: Array.from(r.cssRules).map((k) => ({ key: (k as CSSKeyframeRule).keyText, longhands: longhands((k as CSSKeyframeRule).style) })) });
      } else if ("cssRules" in r && !(r instanceof CSSFontFaceRule)) {
        const head = r.cssText.slice(0, r.cssText.indexOf("{")).trim();
        walk((r as CSSGroupingRule).cssRules, lab, kit, media, [...conds, head], parentSel);
      }
    }
  };
  const sheet = (s: CSSStyleSheet, media: string[], conds: string[], fixedLabel?: string): void => {
    if (isFreeze(s.ownerNode)) return;
    let rules: CSSRuleList;
    try { rules = s.cssRules; } catch { return; }
    const lab = fixedLabel ?? label(s), kit = (s.href ?? "").startsWith(arg.kitBase), m = s.media.mediaText;
    out.sheets.push({ label: lab, href: s.href, kit, media: m });
    if (m && !s.ownerRule) out.media.push({ sheet: lab, kit, condition: m, source: "sheet" });
    walk(rules, lab, kit, m && !s.ownerRule ? [...media, m] : media, m && !s.ownerRule ? [...conds, `@media ${m}`] : conds, null);
  };
  for (const s of Array.from(document.styleSheets)) sheet(s, [], []);
  Array.from(document.adoptedStyleSheets ?? []).forEach((s, i) => sheet(s, [], [], `adopted:${i}`));

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
  const num = (v: string) => parseFloat(v) || 0;
  // the element's own text: its text nodes and those of inline descendants (not of a block or inline-block inside it)
  const ownTexts = (el: Element): Text[] => {
    const list: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\S/.test((n as Text).data)) continue;
      let own = true;
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
        const d = getComputedStyle(p).display;
        if (d !== "inline" && d !== "contents") { own = false; break; }
      }
      if (own) list.push(n as Text);
    }
    return list;
  };
  const textRange = document.createRange();
  /** Lines of the element's own text (fragments that overlap vertically are one line) and how far a wrapping text overflows its content box. */
  const textLines = (el: Element, cs: CSSStyleDeclaration): Pick<RawElement, "lines" | "textOverflow"> => {
    const nodes = ownTexts(el);
    if (!nodes.length) return {};
    const frags: SnapLine[] = [];
    for (const t of nodes) {
      textRange.selectNodeContents(t);
      for (const r of Array.from(textRange.getClientRects())) if (r.height > 0) frags.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    if (!frags.length) return {};
    frags.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines: SnapLine[] = [];
    for (const f of frags) {
      const l = lines[lines.length - 1];
      if (l && f.top < l.bottom - 0.5 * Math.min(f.bottom - f.top, l.bottom - l.top)) {
        l.top = Math.min(l.top, f.top); l.bottom = Math.max(l.bottom, f.bottom); l.left = Math.min(l.left, f.left); l.right = Math.max(l.right, f.right);
      } else lines.push({ ...f });
    }
    if (cs.getPropertyValue("text-wrap-mode") !== "wrap" || cs.display.startsWith("inline")) return { lines };
    const b = el.getBoundingClientRect();
    const left = b.left + num(cs.borderLeftWidth) + num(cs.paddingLeft), right = b.right - num(cs.borderRightWidth) - num(cs.paddingRight);
    if (!lines.some((l) => l.right > right + 0.5 || l.left < left - 0.5)) return { lines };
    // per character (white space hangs and does not count): the farthest one and its word
    let over = { left: 0, right: 0, word: "", wordWidth: 0, boxWidth: right - left }, far = 0.5;
    for (const t of nodes) {
      const d = t.data;
      for (let i = 0; i < d.length; ) {
        const step = d.codePointAt(i)! > 0xffff ? 2 : 1;
        if (/\s/.test(d[i])) { i += step; continue; }
        textRange.setStart(t, i); textRange.setEnd(t, i + step);
        for (const r of Array.from(textRange.getClientRects())) {
          const l = left - r.left, rr = r.right - right;
          over.left = Math.max(over.left, l); over.right = Math.max(over.right, rr);
          if (Math.max(l, rr) > far) {
            far = Math.max(l, rr);
            let a = i, z = i + step;
            while (a > 0 && !/\s/.test(d[a - 1])) a--;
            while (z < d.length && !/\s/.test(d[z])) z++;
            textRange.setStart(t, a); textRange.setEnd(t, z);
            const w = Array.from(textRange.getClientRects()).reduce((m, x) => Math.max(m, x.width), 0);
            over = { ...over, word: d.slice(a, z), wordWidth: w };
          }
        }
        i += step;
      }
    }
    return over.left > 0.5 || over.right > 0.5 ? { lines, textOverflow: over } : { lines };
  };
  els.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const computed: Record<string, string> = {};
    for (const p of arg.props) computed[p] = cs.getPropertyValue(p);
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    const texts: string[] = [];
    for (const c of Array.from(el.childNodes)) if (c.nodeType === 3 && /\S/.test((c as Text).data)) texts.push((c as Text).data);
    const rendered = el.getClientRects().length > 0;
    let size: Size | null = null;
    if (rendered) {
      // layout size without transforms: computed width/height are used values for boxes that are not inline
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      if (Number.isFinite(w) && Number.isFinite(h) && cs.display !== "inline") {
        const extra = cs.boxSizing === "content-box"
          ? [num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth), num(cs.paddingTop) + num(cs.paddingBottom) + num(cs.borderTopWidth) + num(cs.borderBottomWidth)]
          : [0, 0];
        size = { w: w + extra[0], h: h + extra[1] };
      } else { const b = rect(el); size = { w: b.w, h: b.h }; }
    }
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
    // a keyed text as raw tokens (the lint normalizes them with the export's own text rules): a variable keeps its sample
    // text, a child that does not render is left out
    let enToks: EnTok[] | undefined, enRendered: string | null = null;
    if (el.hasAttribute("data-l10n") && el.localName !== "input" && el.localName !== "textarea") {
      const SKIP = ["script", "style", "template", "noscript", "title"];
      const plain = (n: Node): EnTok[] => {
        const r: EnTok[] = [];
        for (const c of Array.from(n.childNodes)) {
          if (c.nodeType === 3) r.push({ text: (c as Text).data });
          else if (c.nodeType === 1) {
            const x = c as Element;
            if (x.localName === "br") r.push({ br: true });
            else if (!SKIP.includes(x.localName) && getComputedStyle(x).display !== "none") r.push(...plain(x));
          }
        }
        return r;
      };
      const walk = (n: Node): EnTok[] => {
        const r: EnTok[] = [];
        for (const c of Array.from(n.childNodes)) {
          if (c.nodeType === 3) r.push({ text: (c as Text).data });
          else if (c.nodeType === 1) {
            const x = c as Element;
            if (x.localName === "br") r.push({ br: true });
            else if (SKIP.includes(x.localName) || getComputedStyle(x).display === "none") continue;
            else if (x.hasAttribute("data-u-arg")) r.push({ arg: x.getAttribute("data-u-arg")!, inner: plain(x) });
            else r.push(...walk(x));
          }
        }
        return r;
      };
      enToks = walk(el);
      enRendered = el.getClientRects().length ? (el as HTMLElement).innerText : null;
    }
    // a bound value or a Smart String argument: its sample as the IR's sample data reads it (extract/text.ts plainText),
    // the text of every descendant whatever CSS shows of it (innerText drops visibility: hidden text and applies
    // text-transform), rendered or not (no invented value anywhere in the design); a field its value attribute, a
    // dropdown its selected option (else its first)
    let boundText: string | undefined;
    if (el.hasAttribute("data-u-bind") || el.hasAttribute("data-u-arg")) {
      const rawText = (n: Node): string => Array.from(n.childNodes).map((c) => c.nodeType === 3 ? (c as Text).data
        : c.nodeType === 1 ? ((c as Element).localName === "br" && (c as Element).namespaceURI === "http://www.w3.org/1999/xhtml" ? "\n" : rawText(c)) : "").join("");
      if (el.localName === "input") boundText = el.getAttribute("value") ?? "";
      else if (el.localName === "select") {
        const opts = Array.from(el.children).filter((c) => c.localName === "option");
        const o = opts.find((c) => c.hasAttribute("selected")) ?? opts[0];
        boundText = o ? rawText(o) : "";
      } else boundText = rawText(el);
    }
    out.elements.push({
      tag: el.localName, ns, attrs, parent: parentIdx, texts, rendered, box: rendered ? rect(el) : null, size, computed, pseudo, inline, vars,
      minAuto: null, shadow: !!(el as HTMLElement).shadowRoot,
      ...(rendered && texts.length ? textLines(el, cs) : {}),
      ...(enToks !== undefined ? { enToks, enRendered } : {}),
      ...(boundText !== undefined ? { boundText } : {}),
    });
  });

  // inline <svg> paints: shapes painted with currentColor take a sentinel colour (the style attribute is restored)
  const SENTINEL = "rgb(1, 2, 3)";
  els.forEach((el, i) => {
    if (el.namespaceURI !== "http://www.w3.org/2000/svg" || el.localName !== "svg" || el.parentElement?.namespaceURI === "http://www.w3.org/2000/svg") return;
    const saved = el.getAttribute("style");
    (el as SVGElement).style.setProperty("color", SENTINEL, "important");
    let cur = false, fixed = false;
    const check = (v: string) => { if (!v || v === "none") return; if (v === SENTINEL) cur = true; else fixed = true; };
    for (const sh of Array.from(el.querySelectorAll("path, circle, rect, line, polyline, polygon, ellipse, text, tspan, textPath, use"))) {
      const cs = getComputedStyle(sh);
      if (cs.display === "none") continue;
      check(cs.fill); check(cs.stroke);
    }
    for (const st of Array.from(el.querySelectorAll("stop"))) check(getComputedStyle(st).stopColor);
    // reading the attribute flushes the pending CSSOM write, so removing it leaves no style=""
    el.getAttribute("style");
    if (saved === null) el.removeAttribute("style"); else el.setAttribute("style", saved);
    out.svgPaint[i] = cur && fixed ? "mixed" : cur ? "current" : fixed ? "fixed" : "none";
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

/**
 * Runs in the page: for each (prefix, rest) pair, the ancestors of each element that match `prefix` and reach it
 * through `rest`, from the parent up to the screen root (never body or html).
 */
function pageAncestors(items: { prefix: string; rest: string; els: number[] }[]): number[][][] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const idx = new Map<Element, number>(els.map((e, i) => [e, i]));
  const root = document.querySelector("[data-u-screen]");
  return items.map(({ prefix, rest, els: list }) => list.map((i) => {
    const out: number[] = [];
    try {
      for (let a = els[i].parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        if (a.matches(prefix) && Array.from(a.querySelectorAll(`:scope ${rest}`)).includes(els[i])) {
          const k = idx.get(a);
          if (k !== undefined) out.push(k);
        }
        if (a === root) break;
      }
    } catch { /* invalid selector: no ancestor */ }
    return out;
  }));
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

/** Longhands Chromium's CSSOM expands each shorthand value into (null when the value does not parse). One page call. */
export async function expandShorthands(page: Page, items: { name: string; value: string }[]): Promise<(SnapDecl[] | null)[]> {
  return items.length ? evaluate(page, pageExpand, items) : [];
}

/** Runs in the page: computed values of properties on elements and their parents (the root for body). */
function pageComputed(items: { i: number; props: string[] }[]): [string, string][][] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  return items.map(({ i, props }) => {
    const el = els[i];
    const cs = getComputedStyle(el), ps = getComputedStyle(el.parentElement ?? document.documentElement);
    return props.map((p) => [cs.getPropertyValue(p), ps.getPropertyValue(p)] as [string, string]);
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

/** How long the snapshot waits for an image (a lazy image outside the viewport never loads). */
export const IMAGE_WAIT_MS = 3000;

/**
 * Runs in the page: the pixel size of each element's image (an `<img>`'s file, else its first url() background image and
 * that layer's index). An image that does not load within `wait` ms is left out.
 */
async function pageImages(wait: number): Promise<[number, { src: string; w: number; h: number; raster: boolean; layer?: number }][]> {
  type Found = [number, { src: string; w: number; h: number; raster: boolean; layer?: number }] | null;
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const vector = (src: string) => /^data:image\/svg/i.test(src) || /\.svg(z)?([?#].*)?$/i.test(src);
  const timeout = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), wait));
  // the file's own pixels: an Image of the chosen source without its srcset (whose density divides naturalWidth)
  const pixels = (src: string) => new Promise<{ w: number; h: number } | null>((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
    im.onerror = () => resolve(null);
    im.src = src;
  });
  const jobs: Promise<Found>[] = [];
  els.forEach((el, i) => {
    if (el instanceof HTMLImageElement) {
      const loaded = el.complete ? Promise.resolve() : new Promise<void>((resolve) => { el.addEventListener("load", () => resolve(), { once: true }); el.addEventListener("error", () => resolve(), { once: true }); });
      const job = loaded.then(async (): Promise<Found> => {
        const src = el.currentSrc || el.src;
        if (!src || !(el.naturalWidth > 0)) return null;
        const own = await pixels(src);
        return own ? [i, { src, w: own.w, h: own.h, raster: !vector(src) }] : null;
      });
      jobs.push(Promise.race([job, timeout()]));
      return;
    }
    const layers = getComputedStyle(el).backgroundImage;
    if (!layers || layers === "none") return;
    // the background-image list's layers, split at top-level commas
    const parts: string[] = [];
    let depth = 0, from = 0;
    for (let k = 0; k < layers.length; k++) {
      const ch = layers[k];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { parts.push(layers.slice(from, k)); from = k + 1; }
    }
    parts.push(layers.slice(from));
    const layer = parts.findIndex((p) => /^\s*url\(/.test(p));
    if (layer < 0) return;
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(parts[layer]);
    if (!m) return;
    const src = m[2];
    jobs.push(Promise.race([pixels(src).then((own): Found => (own ? [i, { src, w: own.w, h: own.h, raster: !vector(src), layer }] : null)), timeout()]));
  });
  return (await Promise.all(jobs)).filter((x): x is NonNullable<Found> => x !== null);
}

async function evaluate<A, R>(page: Page, fn: (a: A) => R, arg: A): Promise<R> {
  return page.evaluate(fn as unknown as (a: unknown) => R, arg as unknown) as Promise<R>;
}

// physical longhands a property name sets (logical properties map to horizontal-tb, left-to-right)
const SIDES = ["top", "right", "bottom", "left"] as const;
const LOGICAL: Record<string, string> = { "block-start": "top", "block-end": "bottom", "inline-start": "left", "inline-end": "right" };
const SHORTHANDS: Record<string, string[]> = {
  margin: SIDES.map((s) => `margin-${s}`), padding: SIDES.map((s) => `padding-${s}`),
  "margin-block": ["margin-top", "margin-bottom"], "margin-inline": ["margin-left", "margin-right"],
  "padding-block": ["padding-top", "padding-bottom"], "padding-inline": ["padding-left", "padding-right"],
  "border-width": SIDES.map((s) => `border-${s}-width`), "border-style": SIDES.map((s) => `border-${s}-style`),
  "border-color": SIDES.map((s) => `border-${s}-color`),
  border: SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  "border-block": ["top", "bottom"].flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  "border-inline": ["left", "right"].flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...Object.fromEntries(SIDES.map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]])),
  inset: [...SIDES], overflow: ["overflow-x", "overflow-y"], "white-space": ["white-space-collapse", "text-wrap-mode"],
  gap: ["row-gap", "column-gap"], "place-items": ["align-items", "justify-items"], "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"], flex: ["flex-grow", "flex-shrink", "flex-basis"], "flex-flow": ["flex-direction", "flex-wrap"],
  "text-decoration": ["text-decoration-line", "text-decoration-style", "text-decoration-color", "text-decoration-thickness"],
  outline: ["outline-color", "outline-style", "outline-width"], "list-style": ["list-style-type", "list-style-position", "list-style-image"],
  background: ["background-color", "background-image"], "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
};
export function physicalNames(name: string): string[] {
  if (SHORTHANDS[name]) return SHORTHANDS[name];
  let n = name;
  for (const [l, p] of Object.entries(LOGICAL)) n = n.replace(new RegExp(`-${l}(?=-|$)`), `-${p}`);
  n = n.replace(/^inset-(top|bottom|left|right)$/, "$1").replace(/^(min-|max-)?inline-size$/, "$1width").replace(/^(min-|max-)?block-size$/, "$1height");
  return [n];
}

const UA_SKIP_TAGS = new Set(["div", "span", "b", "strong", "i", "em", "br", "option", ...NO_TEXT_TAGS, "link", "meta"]);
type CdpProp = { name: string; value: string; disabled?: boolean; parsedOk?: boolean };
type CdpRule = { rule: { origin: string; style: { cssProperties: CdpProp[] } } };

class DomChanged extends Error {}

/**
 * Collects everything lint and extraction read from a loaded design, once: DOM with computed styles and boxes,
 * every style rule with the elements it can reach, at-rules, keyframes, font faces, browser-default styles, the
 * platform fonts that render each text node, and the automatic-minimum-size relayout. Leaves the page as it was.
 * Retries once when the DOM changes while it is read.
 */
export async function collectSnapshot(page: Page, cdp: CDPSession, kit?: KitConfig): Promise<DomSnapshot> {
  try { return await collectOnce(page, cdp, kit); } catch (e) {
    if (!(e instanceof DomChanged)) throw e;
    await page.waitForTimeout(100);
    return collectOnce(page, cdp, kit);
  }
}

async function collectOnce(page: Page, cdp: CDPSession, kit?: KitConfig): Promise<DomSnapshot> {
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
  const reached = raw.rules.map((_, k) => Array.from(new Set(reachOf[k].flatMap((s) => matched[reach.get(s)!] ?? []))).sort((a, b) => a - b));
  // ancestors matching compounds with interaction pseudo-classes or is-* classes (one page call)
  const isState = (x: ParsedSelector["compounds"][number]["simples"][number]) =>
    (x.kind === "pseudo-class" && DYNAMIC_PSEUDO_CLASSES.has(x.name)) || (x.kind === "class" && /^is-/.test(x.name));
  const dynamicOf = (sel: ParsedSelector) => sel.compounds.slice(0, -1).flatMap((c, k) => (c.simples.some(isState) ? [k] : []));
  const ancItems: { prefix: string; rest: string; els: number[] }[] = [];
  const ancSlots = parsed.map((list, k) => list.map((p, j) => dynamicOf(p).map((c) => {
    const els = matched[reach.get(reachOf[k][j])!] ?? [];
    const comp = p.compounds[c];
    const rest = reachSelector({ text: p.text, compounds: p.compounds.slice(c + 1) });
    let prefix = reachSelector({ text: p.text, compounds: p.compounds.slice(0, c + 1) });
    if (comp.simples.every(isState)) {
      // only a state: the ancestors that carry its is-* classes in the markup; pseudo-classes alone name none
      const classes = comp.simples.filter((x) => x.kind === "class").map((x) => x.raw).join("");
      if (!classes) return { compound: c, slot: -1, els };
      const head = c > 0 ? reachSelector({ text: p.text, compounds: p.compounds.slice(0, c) }) + (comp.combinator === ">" ? " > " : " ") : "";
      prefix = head + classes;
    }
    ancItems.push({ prefix, rest, els });
    return { compound: c, slot: ancItems.length - 1, els };
  })));
  const ancFound = ancItems.length ? await evaluate(page, pageAncestors, ancItems) : [];
  lap("match");

  // var() lookup per element (walks up to the root)
  const lookupAt = (i: number) => (name: string): string | undefined => {
    for (let k = i; k >= 0; k = raw.elements[k].parent) if (name in raw.elements[k].vars) return raw.elements[k].vars[name];
    return raw.rootVars[name];
  };
  // shorthands pending var() substitution: expanded per distinct substituted value, in one page call
  const pending: { name: string; value: string }[] = [];
  const slots = new Map<string, number>();
  const slot = (name: string, value: string) => {
    const k = `${name}\u0000${value}`;
    if (!slots.has(k)) { slots.set(k, pending.length); pending.push({ name, value }); }
    return slots.get(k)!;
  };
  type Planned = { d: SnapDecl; slot: number }[];
  const plan = (style: RawStyle, at: number): Planned => {
    const decls = declsOf(style.longhands, style.cssText);
    const known = new Set(style.longhands.map((l) => l.name));
    return decls.map((d) => (known.has(d.name) ? { d, slot: -1 } : { d, slot: slot(d.name, resolveVars(d.value, lookupAt(at))) }));
  };
  const rulePlans = raw.rules.map((r, k) => {
    const els = reached[k];
    const first = plan(r, els[0] ?? -1);
    const per: Record<number, Planned> = {};
    if (first.some((p) => p.slot >= 0)) {
      for (const i of els.slice(1)) {
        const p = plan(r, i);
        if (p.some((x, j) => x.slot !== first[j].slot)) per[i] = p;
      }
    }
    return { first, per };
  });
  const inlinePlans = raw.elements.map((e, i) => (e.inline ? plan(e.inline, i) : null));
  const expanded = pending.length ? await evaluate(page, pageExpand, pending) : [];
  const finish = (list: Planned): SnapDecl[] => list.flatMap(({ d, slot: sl }) => {
    if (sl < 0) return [d];
    const ex = expanded[sl];
    // invalid after substitution: keep the shorthand so rules can report it
    return ex ? ex.map((x) => ({ ...x, important: d.important, via: `${d.name}: ${d.value}` })) : [{ ...d, invalid: true }];
  });
  lap("expand");

  // CDP: node ids, closed shadow roots, platform fonts per text node, browser-default (user-agent) rules
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  type Node = {
    nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; localName?: string; nodeValue?: string;
    children?: Node[]; shadowRoots?: { shadowRootType?: string }[];
  };
  const findBody = (n: Node): Node | null => {
    if (n.nodeType === 1 && (n.localName ?? n.nodeName.toLowerCase()) === "body") return n;
    for (const c of n.children ?? []) { const b = findBody(c); if (b) return b; }
    return null;
  };
  const body = findBody(doc.root as Node);
  const cdpEls: { node: Node; texts: number[]; shadow: "open" | "closed" | null }[] = [];
  const visit = (n: Node) => {
    const sr = (n.shadowRoots ?? []).find((r) => r.shadowRootType !== "user-agent");
    cdpEls.push({
      node: n, shadow: sr ? (sr.shadowRootType === "closed" ? "closed" : "open") : null,
      texts: (n.children ?? []).filter((c) => c.nodeType === 3 && /\S/.test(c.nodeValue ?? "")).map((c) => c.nodeId),
    });
    for (const c of n.children ?? []) if (c.nodeType === 1) visit(c);
  };
  if (body) visit(body);
  if (cdpEls.length !== raw.elements.length || cdpEls.some((c, i) => (c.node.localName ?? c.node.nodeName).toLowerCase() !== raw.elements[i].tag.toLowerCase())) {
    throw new DomChanged("collectSnapshot: the DOM changed while it was being read");
  }
  const inSvg = raw.elements.map(() => false);
  raw.elements.forEach((e, i) => { inSvg[i] = e.ns === "svg" || (e.parent >= 0 && inSvg[e.parent]); });
  const fontJobs = cdpEls.map((c, i) => Promise.all(c.texts.map((id) => {
    if (!raw.elements[i].rendered || NO_TEXT_TAGS.has(raw.elements[i].tag.toLowerCase())) return Promise.resolve(null);
    return cdp.send("CSS.getPlatformFontsForNode", { nodeId: id }).then((r) => r.fonts as PlatformFont[], () => null);
  })));
  const uaIdx = raw.elements.map((e, i) => i).filter((i) => raw.elements[i].ns === "html" && !inSvg[i] && !UA_SKIP_TAGS.has(raw.elements[i].tag));
  const uaJobs = uaIdx.map((i) => cdp.send("CSS.getMatchedStylesForNode", { nodeId: cdpEls[i].node.nodeId }).then((r) => {
    // an author `revert` hands the property back to the browser default: it does not override it
    const reverts = (p: CdpProp) => /^\s*revert(-layer)?\s*(!important)?\s*$/i.test(p.value);
    const names = (rules: CdpRule[] | undefined, ua: boolean) => (rules ?? []).filter((m) => (m.rule.origin === "user-agent") === ua)
      .flatMap((m) => m.rule.style.cssProperties.filter((p) => !p.disabled && (ua || !reverts(p))).flatMap((p) => physicalNames(p.name)));
    const reverted = new Set([
      ...((r.matchedCSSRules ?? []) as CdpRule[]).filter((m) => m.rule.origin !== "user-agent").flatMap((m) => m.rule.style.cssProperties),
      ...((r.inlineStyle?.cssProperties ?? []) as CdpProp[]),
    ].filter((p) => !p.disabled && reverts(p)).flatMap((p) => physicalNames(p.name)));
    const author = new Set([
      ...names(r.matchedCSSRules as CdpRule[], false),
      ...((r.inlineStyle?.cssProperties ?? []) as CdpProp[]).filter((p) => !reverts(p)).flatMap((p) => physicalNames(p.name)),
      ...((r.attributesStyle?.cssProperties ?? []) as CdpProp[]).flatMap((p) => physicalNames(p.name)),
    ].filter((n) => !reverted.has(n)));
    const ignored = new Set(cssSupport.browserDefaults.ignored);
    return Array.from(new Set(names(r.matchedCSSRules as CdpRule[], true)))
      .filter((n) => !author.has(n) && !ignored.has(n) && !/^-(webkit|internal)-/.test(n) && !n.startsWith("font") && n !== "line-height");
  }, () => [] as string[]));
  const [textFonts, uaNames] = await Promise.all([Promise.all(fontJobs), Promise.all(uaJobs)]);
  const uaItems = uaIdx.map((i, k) => ({ i, props: uaNames[k] })).filter((x) => x.props.length);
  const uaValues = uaItems.length ? await evaluate(page, pageComputed, uaItems) : [];
  const ua: Record<number, SnapElement["ua"]> = {};
  uaItems.forEach((x, k) => { ua[x.i] = Object.fromEntries(x.props.map((p, j) => [p, { value: uaValues[k][j][0], parent: uaValues[k][j][1] }])); });
  lap("cdp");

  const fontFaces = await declaredFontFaces(page, kit);
  lap("fonts");
  const images = new Map(await page.evaluate(pageImages, IMAGE_WAIT_MS));
  lap("images");

  const elements: SnapElement[] = raw.elements.map((e, i) => ({
    index: i, tag: e.tag, ns: e.ns as SnapElement["ns"], attrs: e.attrs, parent: e.parent, children: children[i], path: paths[i],
    nodeId: cdpEls[i].node.nodeId, backendNodeId: cdpEls[i].node.backendNodeId,
    texts: e.texts, textFonts: textFonts[i].length === e.texts.length ? textFonts[i] : e.texts.map(() => null),
    rendered: e.rendered, box: e.box, size: e.size, computed: e.computed, pseudo: e.pseudo,
    inline: inlinePlans[i] ? finish(inlinePlans[i]!) : null, vars: e.vars, minAuto: e.minAuto,
    shadowRoot: e.shadow ? "open" : cdpEls[i].shadow, ua: ua[i] ?? {},
    ...(e.lines ? { lines: e.lines } : {}), ...(e.textOverflow ? { textOverflow: e.textOverflow } : {}),
    ...(e.enToks !== undefined ? { enToks: e.enToks, enRendered: e.enRendered ?? null } : {}),
    ...(e.boundText !== undefined ? { boundText: e.boundText } : {}),
    ...(raw.svgPaint[i] ? { svgPaint: raw.svgPaint[i] } : {}),
    ...(images.has(i) ? { image: images.get(i) } : {}),
  }));
  const rules: SnapRule[] = raw.rules.map((r, k) => ({
    index: r.index, sheet: r.sheet, kit: r.kit, selectorText: r.selectorText, media: r.media, conditions: r.conditions,
    decls: finish(rulePlans[k].first), declsAt: Object.fromEntries(Object.entries(rulePlans[k].per).map(([i, p]) => [i, finish(p)])),
    path: `${r.sheet} ${r.selectorText}`,
    selectors: parsed[k].map((p, j) => ({
      text: p.text, parsed: p, reach: reachOf[k][j], specificity: specificity(p), pseudoClasses: pseudoClasses(p), pseudoElement: pseudoElement(p),
      structural: structural(p), elements: matched[reach.get(reachOf[k][j])!],
      dynamicAncestors: ancSlots[k][j].map((a) => ({
        compound: a.compound, bare: a.slot < 0,
        matches: a.slot < 0 ? {} : Object.fromEntries(a.els.map((i, n) => [i, ancFound[a.slot][n]])),
      })),
    })),
  }));
  const s: DomSnapshot = {
    viewport: raw.viewport, elements, rules,
    media: raw.media.map((m) => ({ ...m, path: `${m.sheet} @media ${m.condition}` })),
    keyframes: raw.keyframes.map((k) => ({ sheet: k.sheet, kit: k.kit, name: k.name, path: `${k.sheet} @keyframes ${k.name}`, frames: k.frames.map((f) => ({ key: f.key, decls: f.longhands })) })),
    sheets: raw.sheets, atRules: raw.atRules.map((a) => ({ ...a, path: `${a.sheet} @${a.kind}${a.prelude ? ` ${a.prelude}` : ""}` })),
    fontFaces, rootVars: raw.rootVars, rootFontSize: px(raw.rootFontSize) ?? 16, timings,
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
  const promoted = promotedRuns(s);
  for (const e of s.elements) {
    if (!rendersText(e)) continue;
    const size = px(e.computed["font-size"]), weight = Number(e.computed["font-weight"]);
    if (size === null) { e.textStyle = null; continue; }
    // a keyed inline run is a text node of its own (promoted, or keyed beside an icon in a box that is not a text): it needs a
    // full kit style, line height included; only unkeyed rich text inside a paragraph takes the paragraph's line
    const lh = px(e.computed["line-height"]);
    const m = isInlineLevel(e) && e.ns === "html" && e.texts.length > 0 && !promoted.has(e.index) && !isKeyed(e)
      ? matchRichStyle(styles, size, weight, lh)
      : matchTextStyle(styles, size, lh, weight);
    e.textStyle = m ? m.name : null;
  }
}
