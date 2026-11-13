/**
 * The CSS the pipeline supports, in one place. Rules read it only through `cssSupport` so this data can later be
 * replaced by a loader of the Unity package's css-support.json (same shape: property → handling, keywords, types,
 * value maps) without touching the rules.
 *
 * handling: direct = written to USS; lowered = rewritten by the compiler (gap → margins, z-index → order,
 * display: block → column); dropped = accepted and omitted (baked by the exporter, or no effect in UI Toolkit);
 * error = never supported.
 */

export type Handling = "direct" | "lowered" | "dropped" | "error";
export interface PropertySupport {
  handling: Handling;
  /** Allowed keywords; when absent any keyword passes the keyword check. */
  keywords?: string[];
  /** Value types besides the keywords (length, percent, number, color, angle, time, ratio, ident, string). */
  types?: string[];
  /** Keyword aliases the compiler rewrites (accepted as is). */
  mapValues?: Record<string, string>;
  /** Comma-separated list allowed. */
  list?: boolean;
  /** The lint rule that owns the property's values (or the values in `owns`); U-CSS-023 leaves them to it. */
  rule?: string;
  /** Keywords another rule (`rule`) reports, so U-CSS-023 does not report them twice. */
  owns?: string[];
}

export interface CssSupportData {
  version: number;
  units: string[];
  colors: { functions: string[]; keywords: string[] };
  properties: Record<string, PropertySupport>;
  /** CSS initial values (as Chromium serialises them) of unsupported longhands that shorthands write; never flagged. */
  initialValues: Record<string, string[]>;
  /** SVG presentation properties: allowed on elements inside an inline <svg>, which is exported as a vector asset. */
  svgPresentation: string[];
  valueFunctions: string[];
  transformFunctions: string[];
  keyframeProperties: string[];
  timingKeywords: string[];
  mediaFeatures: string[];
  mediaTypes: string[];
  layoutTransitionProperties: string[];
  pseudoElements: string[];
  /** Pseudo-classes USS has (structural ones belong to U-CSS-003). */
  pseudoClasses: string[];
  /** At-rules: name → "any" or "kit" (only in the kit's own sheets). */
  atRules: Record<string, "any" | "kit">;
  /** HTML elements the compiler maps; `input` only with these types. SVG elements are exported as vector assets. */
  elements: string[];
  inputTypes: string[];
  browserDefaults: {
    /** Inherited properties: a browser default is harmless when it equals the parent's value. */
    inherited: string[];
    /** Non-inherited properties: computed values equal to the CSS initial value (what UI Toolkit starts from). */
    initial: Record<string, string[]>;
    /** Properties whose browser default never matters to the compiled screen (or another rule judges it). */
    ignored: string[];
    /** Browser defaults the pipeline reproduces, per tag. */
    reproduced: Record<string, string[]>;
  };
}

const LEN = ["length", "percent"];
const kw = (handling: Handling, keywords: string[], extra: Partial<PropertySupport> = {}): PropertySupport => ({ handling, keywords, ...extra });
const ty = (handling: Handling, types: string[], extra: Partial<PropertySupport> = {}): PropertySupport => ({ handling, types, ...extra });
const BASELINE = ["baseline", "first", "last"];
const DROPPED = { handling: "dropped" as const };

export const CSS_SUPPORT_DATA: CssSupportData = {
  version: 1,
  units: ["px", "%", "rem", "s", "ms", "deg", "rad", "grad", "turn"],
  colors: {
    functions: ["rgb", "rgba", "hsl", "hsla"],
    keywords: ["transparent", "white", "black", "red", "green", "blue", "yellow", "cyan", "magenta", "gray", "grey", "orange",
      "purple", "pink", "brown", "silver", "gold", "navy", "teal", "lime", "maroon", "olive", "aqua", "fuchsia"],
  },
  properties: {
    // no effect in UI Toolkit, or a hint only
    "-webkit-font-smoothing": DROPPED, "-webkit-tap-highlight-color": DROPPED, "-webkit-text-size-adjust": DROPPED,
    "text-size-adjust": DROPPED, "text-rendering": DROPPED, "will-change": DROPPED, "cursor": DROPPED, "user-select": DROPPED,
    "justify-items": DROPPED, "justify-self": DROPPED, "outline-color": DROPPED, "outline-offset": DROPPED,
    "appearance": kw("dropped", ["none"]),
    "outline-style": kw("dropped", ["none"]),
    "outline-width": kw("dropped", ["0", "0px", "medium"]),
    "resize": kw("dropped", ["none"]),
    // layout
    "display": kw("lowered", ["block", "flex", "none", "inline", "inline-block", "inline-flex"], { rule: "U-CSS-001", owns: ["grid", "inline-grid"] }),
    "position": kw("direct", ["static", "relative", "absolute"], { rule: "U-CSS-017", owns: ["fixed", "sticky", "-webkit-sticky"] }),
    "float": { handling: "error", rule: "U-CSS-017" },
    "top": kw("direct", ["auto"], { types: LEN }), "right": kw("direct", ["auto"], { types: LEN }),
    "bottom": kw("direct", ["auto"], { types: LEN }), "left": kw("direct", ["auto"], { types: LEN }),
    "z-index": { handling: "lowered", rule: "U-CSS-004" },
    "width": kw("direct", ["auto"], { types: LEN }), "height": kw("direct", ["auto"], { types: LEN }),
    "min-width": kw("direct", ["auto"], { types: LEN }), "min-height": kw("direct", ["auto"], { types: LEN }),
    "max-width": kw("direct", ["none"], { types: LEN }), "max-height": kw("direct", ["none"], { types: LEN }),
    "aspect-ratio": kw("direct", ["auto"], { types: ["ratio", "number"] }),
    "box-sizing": kw("lowered", ["border-box", "content-box"]),
    "margin-top": kw("direct", ["auto"], { types: LEN }), "margin-right": kw("direct", ["auto"], { types: LEN }),
    "margin-bottom": kw("direct", ["auto"], { types: LEN }), "margin-left": kw("direct", ["auto"], { types: LEN }),
    "padding-top": ty("direct", LEN), "padding-right": ty("direct", LEN), "padding-bottom": ty("direct", LEN), "padding-left": ty("direct", LEN),
    "flex-direction": kw("direct", ["row", "column", "row-reverse", "column-reverse"]),
    "flex-wrap": kw("direct", ["nowrap", "wrap", "wrap-reverse"]),
    "flex-grow": ty("direct", ["number"]), "flex-shrink": ty("direct", ["number"]),
    "flex-basis": kw("direct", ["auto"], { types: LEN }),
    "justify-content": kw("direct", ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]),
    "align-items": kw("direct", ["flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018", owns: BASELINE }),
    "align-self": kw("direct", ["auto", "flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018", owns: BASELINE }),
    "align-content": kw("direct", ["auto", "flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018", owns: BASELINE }),
    "row-gap": { handling: "lowered", rule: "U-CSS-011" }, "column-gap": { handling: "lowered", rule: "U-CSS-011" },
    // overflow: visible/hidden map to USS; auto/scroll make the element a scroll area (ScrollView, spec §10)
    "overflow-x": kw("direct", ["visible", "hidden", "auto", "scroll"], { mapValues: { clip: "hidden" } }),
    "overflow-y": kw("direct", ["visible", "hidden", "auto", "scroll"], { mapValues: { clip: "hidden" } }),
    "visibility": kw("direct", ["visible", "hidden"]),
    "opacity": ty("direct", ["number"]),
    "pointer-events": kw("lowered", ["auto", "none"]),
    // paint
    "color": ty("direct", ["color"]),
    "background-color": ty("direct", ["color"]),
    // gradients are baked to SVG, url() images become assets (U-CSS-014: what cannot be baked, U-CSS-022: hard stops)
    "background-image": { handling: "dropped", keywords: ["none"], list: true, rule: "U-CSS-022" },
    // url() backgrounds become IR background assets; their size, repeat and position stay in the style layers
    "background-size": kw("direct", ["auto", "cover", "contain"], { types: LEN, list: true }),
    "background-repeat": kw("direct", ["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"], { list: true }),
    "background-position-x": kw("direct", ["left", "center", "right"], { types: LEN, list: true }),
    "background-position-y": kw("direct", ["top", "center", "bottom"], { types: LEN, list: true }),
    "border-top-color": ty("direct", ["color"]), "border-right-color": ty("direct", ["color"]),
    "border-bottom-color": ty("direct", ["color"]), "border-left-color": ty("direct", ["color"]),
    "border-top-width": ty("direct", ["length"]), "border-right-width": ty("direct", ["length"]),
    "border-bottom-width": ty("direct", ["length"]), "border-left-width": ty("direct", ["length"]),
    "border-top-style": { handling: "dropped", rule: "U-CSS-021" }, "border-right-style": { handling: "dropped", rule: "U-CSS-021" },
    "border-bottom-style": { handling: "dropped", rule: "U-CSS-021" }, "border-left-style": { handling: "dropped", rule: "U-CSS-021" },
    "border-top-left-radius": ty("direct", LEN, { rule: "U-CSS-020" }), "border-top-right-radius": ty("direct", LEN, { rule: "U-CSS-020" }),
    "border-bottom-right-radius": ty("direct", LEN, { rule: "U-CSS-020" }), "border-bottom-left-radius": ty("direct", LEN, { rule: "U-CSS-020" }),
    // baked by the exporter (outer and inset shadows, per layer); U-CSS-014 rejects what cannot be baked
    "box-shadow": { handling: "dropped", rule: "U-CSS-014" },
    // content images: fill → stretch-to-fill, contain → scale-to-fit, cover → scale-and-crop (-unity-background-scale-mode), centred
    "object-fit": kw("lowered", ["fill", "contain", "cover"]),
    "object-position": kw("dropped", ["center", "50%"]),
    "filter": { handling: "error", rule: "U-CSS-015" },
    "backdrop-filter": { handling: "error", rule: "U-CSS-007" },
    "transform": { handling: "lowered", rule: "U-CSS-025" },
    "translate": { handling: "direct", rule: "U-CSS-025" }, "rotate": { handling: "direct", rule: "U-CSS-025" },
    "scale": { handling: "direct", rule: "U-CSS-025" },
    "transform-origin": kw("direct", ["left", "center", "right", "top", "bottom"], { types: LEN }),
    "content": { handling: "error", rule: "U-CSS-002" },
    "list-style-type": { handling: "dropped", rule: "U-CSS-002" },
    "list-style-image": { handling: "dropped", rule: "U-CSS-002" },
    "list-style-position": { handling: "dropped", rule: "U-CSS-002" },
    // text
    "font-family": { handling: "direct", rule: "U-CSS-010" },
    "font-size": { handling: "direct", rule: "U-CSS-016" },
    "font-weight": { handling: "direct", rule: "U-CSS-016" },
    "line-height": { handling: "dropped", rule: "U-CSS-016" },
    "font-style": kw("direct", ["normal", "italic"]),
    "letter-spacing": kw("direct", ["normal"], { types: ["length"] }),
    "word-spacing": kw("direct", ["normal"], { types: ["length"] }),
    "text-align": kw("direct", ["left", "center", "right"], { mapValues: { start: "left", end: "right" } }),
    "text-overflow": kw("direct", ["clip", "ellipsis"]),
    "text-shadow": kw("direct", ["none"], { types: ["length", "color"] }),
    "white-space-collapse": kw("direct", ["collapse", "preserve"]),
    "text-wrap-mode": kw("direct", ["wrap", "nowrap"]),
    // transitions and keyframe animations (spec §11); keyframe bodies are U-CSS-013's
    "transition-property": ty("direct", ["ident"], { list: true }),
    "transition-duration": ty("direct", ["time"], { list: true }),
    "transition-delay": ty("direct", ["time"], { list: true }),
    "transition-timing-function": { handling: "direct", list: true, rule: "U-CSS-008" },
    "transition-behavior": kw("dropped", ["normal"], { list: true }),
    "animation-name": ty("lowered", ["ident"], { list: true }),
    "animation-duration": ty("lowered", ["time"], { list: true }),
    "animation-delay": ty("lowered", ["time"], { list: true }),
    "animation-timing-function": { handling: "lowered", list: true, rule: "U-CSS-008" },
    "animation-iteration-count": kw("lowered", ["infinite"], { types: ["number"], list: true }),
    "animation-direction": kw("lowered", ["normal", "reverse", "alternate", "alternate-reverse"], { list: true }),
    "animation-fill-mode": kw("lowered", ["none", "forwards", "backwards", "both"], { list: true }),
    "animation-play-state": kw("lowered", ["running", "paused"], { list: true }),
  },
  initialValues: {
    "border-image-source": ["none"], "border-image-slice": ["100%"], "border-image-width": ["1"], "border-image-outset": ["0"],
    "border-image-repeat": ["stretch"],
    "background-position-x": ["0%"], "background-position-y": ["0%"], "background-size": ["auto"], "background-repeat": ["repeat"],
    "background-attachment": ["scroll"], "background-origin": ["padding-box"], "background-clip": ["border-box"],
    "font-variant-caps": ["normal"], "font-variant-ligatures": ["normal"], "font-variant-numeric": ["normal"],
    "font-variant-east-asian": ["normal"], "font-variant-alternates": ["normal"], "font-variant-position": ["normal"],
    "font-variant-emoji": ["normal"], "font-size-adjust": ["none"], "font-language-override": ["normal"], "font-kerning": ["auto"],
    "font-optical-sizing": ["auto"], "font-feature-settings": ["normal"], "font-variation-settings": ["normal"],
    "font-stretch": ["normal", "100%"],
    "text-decoration-line": ["none"], "text-decoration-thickness": ["auto"], "text-decoration-style": ["solid"],
    "text-decoration-color": ["currentcolor"],
    "animation-timeline": ["auto"], "animation-range-start": ["normal"], "animation-range-end": ["normal"],
    "animation-composition": ["replace"], "text-wrap-style": ["auto"],
  },
  svgPresentation: ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "clip-rule", "color-interpolation",
    "color-interpolation-filters", "color-rendering", "flood-color", "flood-opacity", "lighting-color", "marker-start",
    "marker-mid", "marker-end", "paint-order", "shape-rendering", "stop-color", "stop-opacity", "text-anchor",
    "dominant-baseline", "vector-effect", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "transform-box", "mask-type", "color"],
  valueFunctions: ["var", "rgb", "rgba", "hsl", "hsla", "linear-gradient", "radial-gradient", "url"],
  transformFunctions: ["translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate"],
  keyframeProperties: ["transform", "translate", "rotate", "scale", "opacity", "color", "background-color", "border-color",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "animation-timing-function"],
  timingKeywords: ["linear", "ease", "ease-in", "ease-out", "ease-in-out"],
  mediaFeatures: ["min-width", "max-width", "min-aspect-ratio", "max-aspect-ratio"],
  mediaTypes: ["all", "screen"],
  layoutTransitionProperties: ["all", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "margin-top",
    "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "top", "right", "bottom", "left", "inset", "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-direction", "flex-wrap",
    "flex-flow"],
  pseudoElements: ["before", "after", "placeholder"],
  pseudoClasses: ["hover", "active", "focus", "disabled", "checked", "root"],
  atRules: { media: "any", keyframes: "any", import: "kit", "font-face": "kit" },
  elements: ["body", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "button", "input", "textarea", "select", "option",
    "label", "img", "svg", "br", "ul", "ol", "li", "a", "section", "header", "footer", "nav", "main", "aside", "article",
    "b", "strong", "i", "em"],
  // text fields (TextField), toggles (Toggle); range has no compiled control
  inputTypes: ["text", "search", "password", "number", "email", "tel", "url", "checkbox", "radio"],
  browserDefaults: {
    inherited: ["color", "text-align", "text-indent", "text-transform", "text-shadow", "letter-spacing", "word-spacing",
      "white-space-collapse", "text-wrap-mode", "overflow-wrap", "word-break", "line-break", "visibility", "tab-size",
      "hyphens", "text-align-last", "text-justify", "text-underline-position", "text-emphasis-style", "text-emphasis-color"],
    initial: {
      "margin-top": ["0px"], "margin-right": ["0px"], "margin-bottom": ["0px"], "margin-left": ["0px"],
      "padding-top": ["0px"], "padding-right": ["0px"], "padding-bottom": ["0px"], "padding-left": ["0px"],
      "border-top-width": ["0px"], "border-right-width": ["0px"], "border-bottom-width": ["0px"], "border-left-width": ["0px"],
      "background-color": ["rgba(0, 0, 0, 0)"], "background-image": ["none"], "appearance": ["none"],
      "text-decoration-line": ["none"], "vertical-align": ["baseline"], "resize": ["none"], "opacity": ["1"],
      "box-shadow": ["none"], "float": ["none"], "position": ["static"], "z-index": ["auto"], "object-fit": ["fill"],
      "min-width": ["auto", "0px"], "min-height": ["auto", "0px"], "max-width": ["none"], "max-height": ["none"],
      "overflow-x": ["visible"], "overflow-y": ["visible"], "column-count": ["auto"], "transform": ["none"],
      "align-items": ["normal"], "align-self": ["auto"], "align-content": ["normal"], "justify-content": ["normal"],
      "flex-direction": ["row"], "flex-wrap": ["nowrap"], "outline-style": ["none"],
      "border-top-left-radius": ["0px"], "border-top-right-radius": ["0px"], "border-bottom-right-radius": ["0px"],
      "border-bottom-left-radius": ["0px"],
    },
    ignored: ["display", "unicode-bidi", "direction", "writing-mode", "cursor", "user-select", "text-rendering", "text-autospace",
      "overflow-clip-margin", "caret-color", "box-sizing", "list-style-type", "list-style-position", "list-style-image",
      "content", "quotes", "line-height", "text-size-adjust", "text-decoration-thickness", "text-decoration-style",
      "text-decoration-color", "outline-color", "outline-offset", "outline-width", "border-image-source", "border-image-slice",
      "border-image-width", "border-image-outset", "border-image-repeat", "animation-name", "transition-property",
      "pointer-events", "touch-action", "speak", "zoom"],
    reproduced: {
      img: ["overflow-x", "overflow-y"], svg: ["overflow-x", "overflow-y"],
      // text controls: clipping, the single-line select label and multi-line textarea wrapping are the control's own
      // a button's centred label reaches Unity through the IR as middle-center
      button: ["text-align"],
      input: ["overflow-x", "overflow-y"],
      textarea: ["overflow-x", "overflow-y", "white-space-collapse", "text-wrap-mode", "overflow-wrap"],
      select: ["overflow-x", "overflow-y", "white-space-collapse", "text-wrap-mode", "align-items"],
    },
  },
};

export interface CssSupport {
  property(name: string): PropertySupport | null;
  /** Listed with a handling other than "error". */
  isAllowedProperty(name: string): boolean;
  /** Keywords the property accepts (aliases included), or null when its keywords are unconstrained. */
  allowedValuesFor(name: string): readonly string[] | null;
  /** The value equals the property's CSS initial value (what a shorthand writes for an omitted part). */
  isInitialValue(name: string, value: string): boolean;
  isAllowedFunction(name: string): boolean;
  isAllowedUnit(unit: string): boolean;
  isAllowedColorKeyword(word: string): boolean;
  isSvgPresentation(name: string): boolean;
  isTransformFunction(name: string): boolean;
  isKeyframeProperty(name: string): boolean;
  isTimingKeyword(name: string): boolean;
  isMediaFeature(name: string): boolean;
  isMediaType(name: string): boolean;
  isLayoutTransitionProperty(name: string): boolean;
  isAllowedPseudoElement(name: string): boolean;
  isAllowedPseudoClass(name: string): boolean;
  /** "any", "kit" (only in kit sheets) or null (not supported). */
  atRule(name: string): "any" | "kit" | null;
  isAllowedElement(tag: string, attrs: Record<string, string>): boolean;
  readonly browserDefaults: CssSupportData["browserDefaults"];
  readonly timingKeywords: readonly string[];
  readonly keyframeProperties: readonly string[];
  readonly mediaFeatures: readonly string[];
  readonly pseudoClasses: readonly string[];
  readonly elements: readonly string[];
  readonly inputTypes: readonly string[];
}

export function cssSupportFrom(d: CssSupportData): CssSupport {
  const set = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
  const fns = set(d.valueFunctions), tf = set(d.transformFunctions), kf = set(d.keyframeProperties), tk = set(d.timingKeywords);
  const mf = set(d.mediaFeatures), mt = set(d.mediaTypes), lt = set(d.layoutTransitionProperties), pe = set(d.pseudoElements);
  const units = set(d.units), colors = set(d.colors.keywords), svg = set(d.svgPresentation), pc = set(d.pseudoClasses);
  const els = set(d.elements), types = set(d.inputTypes);
  return {
    property: (n) => d.properties[n] ?? null,
    isAllowedProperty: (n) => !!d.properties[n] && d.properties[n].handling !== "error",
    allowedValuesFor: (n) => {
      const p = d.properties[n];
      if (!p?.keywords) return null;
      return [...p.keywords, ...Object.keys(p.mapValues ?? {})];
    },
    isInitialValue: (n, v) => v.trim().toLowerCase() === "initial" || (d.initialValues[n] ?? []).includes(v.trim().toLowerCase()),
    isAllowedFunction: (n) => fns.has(n.toLowerCase()),
    isAllowedUnit: (u) => u === "" || units.has(u.toLowerCase()),
    isAllowedColorKeyword: (w) => colors.has(w.toLowerCase()),
    isSvgPresentation: (n) => svg.has(n.toLowerCase()),
    isTransformFunction: (n) => tf.has(n.toLowerCase()),
    isKeyframeProperty: (n) => kf.has(n.toLowerCase()),
    isTimingKeyword: (n) => tk.has(n.toLowerCase()),
    isMediaFeature: (n) => mf.has(n.toLowerCase()),
    isMediaType: (n) => mt.has(n.toLowerCase()),
    isLayoutTransitionProperty: (n) => lt.has(n.toLowerCase()),
    isAllowedPseudoElement: (n) => pe.has(n.toLowerCase()),
    isAllowedPseudoClass: (n) => pc.has(n.toLowerCase()),
    atRule: (n) => d.atRules[n.toLowerCase()] ?? null,
    isAllowedElement: (tag, attrs) => {
      const t = tag.toLowerCase();
      if (!els.has(t)) return false;
      return t !== "input" || types.has((attrs.type ?? "text").toLowerCase());
    },
    browserDefaults: d.browserDefaults,
    timingKeywords: d.timingKeywords,
    keyframeProperties: d.keyframeProperties,
    mediaFeatures: d.mediaFeatures,
    pseudoClasses: d.pseudoClasses,
    elements: d.elements,
    inputTypes: d.inputTypes,
  };
}

export const cssSupport: CssSupport = cssSupportFrom(CSS_SUPPORT_DATA);
