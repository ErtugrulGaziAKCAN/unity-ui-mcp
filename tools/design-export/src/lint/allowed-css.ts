/**
 * The CSS the pipeline supports, in one place. Rules read it only through `cssSupport` so this data can later be
 * replaced by a loader of the Unity package's css-support.json (same shape: property → handling, keywords, types,
 * value maps) without touching the rules.
 *
 * handling: direct = written to USS; lowered = rewritten by the compiler (gap → margins, z-index → order);
 * dropped = accepted and omitted (baked by the exporter or irrelevant to UI Toolkit); error = never supported.
 */

export type Handling = "direct" | "lowered" | "dropped" | "error";
export interface PropertySupport {
  handling: Handling;
  /** Allowed keywords; when absent any keyword passes this check. */
  keywords?: string[];
  /** Value types besides the keywords (length, percent, number, color, angle, time, ratio, ident, string). */
  types?: string[];
  /** Keyword aliases the compiler rewrites (accepted as is). */
  mapValues?: Record<string, string>;
  /** Comma-separated list allowed. */
  list?: boolean;
  /** The lint rule that owns the property's values; U-CSS-023 then leaves them to it. */
  rule?: string;
}

export interface CssSupportData {
  version: number;
  units: string[];
  colors: { functions: string[]; keywords: string[] };
  properties: Record<string, PropertySupport>;
  /** CSS initial values (as Chromium serialises them) of unsupported longhands that shorthands write; never flagged. */
  initialValues: Record<string, string[]>;
  valueFunctions: string[];
  transformFunctions: string[];
  keyframeProperties: string[];
  timingKeywords: string[];
  mediaFeatures: string[];
  layoutTransitionProperties: string[];
  pseudoElements: string[];
}

const LEN = ["length", "percent"];
const kw = (handling: Handling, keywords: string[], extra: Partial<PropertySupport> = {}): PropertySupport => ({ handling, keywords, ...extra });
const ty = (handling: Handling, types: string[], extra: Partial<PropertySupport> = {}): PropertySupport => ({ handling, types, ...extra });

export const CSS_SUPPORT_DATA: CssSupportData = {
  version: 1,
  units: ["px", "%", "rem", "s", "ms", "deg", "rad", "grad", "turn"],
  colors: {
    functions: ["rgb", "rgba", "hsl", "hsla"],
    keywords: ["transparent", "white", "black", "red", "green", "blue", "yellow", "cyan", "magenta", "gray", "grey", "orange",
      "purple", "pink", "brown", "silver", "gold", "navy", "teal", "lime", "maroon", "olive", "aqua", "fuchsia"],
  },
  properties: {
    "-webkit-font-smoothing": { handling: "dropped" },
    "-webkit-tap-highlight-color": { handling: "dropped" },
    "align-content": kw("direct", ["auto", "flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018" }),
    "align-items": kw("direct", ["flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018" }),
    "align-self": kw("direct", ["auto", "flex-start", "flex-end", "center", "stretch"], { rule: "U-CSS-018" }),
    "aspect-ratio": kw("direct", ["auto"], { types: ["ratio", "number"] }),
    "backdrop-filter": { handling: "error", rule: "U-CSS-007" },
    "background-color": ty("direct", ["color"]),
    "background-image": { handling: "dropped", keywords: ["none"], list: true, rule: "U-CSS-022" },
    "border-top-color": ty("direct", ["color"]), "border-right-color": ty("direct", ["color"]),
    "border-bottom-color": ty("direct", ["color"]), "border-left-color": ty("direct", ["color"]),
    "border-top-width": ty("direct", ["length"]), "border-right-width": ty("direct", ["length"]),
    "border-bottom-width": ty("direct", ["length"]), "border-left-width": ty("direct", ["length"]),
    "border-top-style": kw("dropped", ["solid", "none"], { rule: "U-CSS-021" }), "border-right-style": kw("dropped", ["solid", "none"], { rule: "U-CSS-021" }),
    "border-bottom-style": kw("dropped", ["solid", "none"], { rule: "U-CSS-021" }), "border-left-style": kw("dropped", ["solid", "none"], { rule: "U-CSS-021" }),
    "border-top-left-radius": ty("direct", LEN, { rule: "U-CSS-020" }), "border-top-right-radius": ty("direct", LEN, { rule: "U-CSS-020" }),
    "border-bottom-right-radius": ty("direct", LEN, { rule: "U-CSS-020" }), "border-bottom-left-radius": ty("direct", LEN, { rule: "U-CSS-020" }),
    "bottom": kw("direct", ["auto"], { types: LEN }), "top": kw("direct", ["auto"], { types: LEN }),
    "left": kw("direct", ["auto"], { types: LEN }), "right": kw("direct", ["auto"], { types: LEN }),
    "box-shadow": { handling: "dropped", rule: "U-CSS-014" },
    "box-sizing": kw("dropped", ["border-box"]),
    "color": ty("direct", ["color"]),
    "column-gap": { handling: "lowered", rule: "U-CSS-011" }, "row-gap": { handling: "lowered", rule: "U-CSS-011" },
    "content": { handling: "error", rule: "U-CSS-002" },
    "cursor": { handling: "dropped" },
    "display": kw("direct", ["flex", "none"], { rule: "U-CSS-001" }),
    "filter": { handling: "error", rule: "U-CSS-015" },
    "flex-basis": kw("direct", ["auto"], { types: LEN }),
    "flex-direction": kw("direct", ["row", "column", "row-reverse", "column-reverse"]),
    "flex-grow": ty("direct", ["number"]), "flex-shrink": ty("direct", ["number"]),
    "flex-wrap": kw("direct", ["nowrap", "wrap", "wrap-reverse"]),
    "float": { handling: "error", rule: "U-CSS-017" },
    "font-family": ty("direct", ["string", "ident"], { list: true, rule: "U-CSS-010" }),
    "font-size": ty("direct", ["length"], { rule: "U-CSS-016" }),
    "font-style": kw("direct", ["normal", "italic"]),
    "font-weight": kw("direct", ["normal", "bold", "400", "700"], { rule: "U-CSS-016" }),
    "height": kw("direct", ["auto"], { types: LEN }), "width": kw("direct", ["auto"], { types: LEN }),
    "justify-content": kw("direct", ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]),
    "letter-spacing": ty("direct", ["length"]), "word-spacing": ty("direct", ["length"]),
    "line-height": { handling: "dropped", rule: "U-CSS-016" },
    // list markers are generated content (U-CSS-002); list-style: none only removes them
    "list-style-type": kw("dropped", ["none"], { rule: "U-CSS-002" }),
    "list-style-image": kw("dropped", ["none"], { rule: "U-CSS-002" }),
    "list-style-position": kw("dropped", ["outside", "inside"], { rule: "U-CSS-002" }),
    "margin-top": kw("direct", ["auto"], { types: LEN }), "margin-right": kw("direct", ["auto"], { types: LEN }),
    "margin-bottom": kw("direct", ["auto"], { types: LEN }), "margin-left": kw("direct", ["auto"], { types: LEN }),
    "max-height": kw("direct", ["none"], { types: LEN }), "max-width": kw("direct", ["none"], { types: LEN }),
    "min-height": kw("direct", ["auto"], { types: LEN }), "min-width": kw("direct", ["auto"], { types: LEN }),
    "opacity": ty("direct", ["number"]),
    "outline": { handling: "error" },
    "overflow-x": kw("direct", ["visible", "hidden"], { mapValues: { clip: "hidden" } }),
    "overflow-y": kw("direct", ["visible", "hidden"], { mapValues: { clip: "hidden" } }),
    "padding-top": ty("direct", LEN), "padding-right": ty("direct", LEN), "padding-bottom": ty("direct", LEN), "padding-left": ty("direct", LEN),
    "pointer-events": { handling: "lowered" },
    "position": kw("direct", ["relative", "absolute"], { rule: "U-CSS-017" }),
    "rotate": kw("direct", ["none"], { types: ["angle"], rule: "U-CSS-025" }),
    "scale": kw("direct", ["none"], { types: ["number"], rule: "U-CSS-025" }),
    "translate": kw("direct", ["none"], { types: LEN, rule: "U-CSS-025" }),
    "transform": kw("lowered", ["none"], { rule: "U-CSS-025" }),
    "transform-origin": kw("direct", ["left", "center", "right", "top", "bottom"], { types: LEN }),
    "text-align": kw("direct", ["left", "center", "right"], { mapValues: { start: "left", end: "right" } }),
    "text-overflow": kw("direct", ["clip", "ellipsis"]),
    "text-shadow": kw("direct", ["none"], { types: ["length", "color"] }),
    "text-transform": { handling: "error" },
    "text-wrap-mode": kw("direct", ["wrap", "nowrap"]),
    "transition-behavior": kw("dropped", ["normal"], { list: true }),
    "transition-delay": ty("direct", ["time"], { list: true }),
    "transition-duration": ty("direct", ["time"], { list: true }),
    "transition-property": ty("direct", ["ident"], { list: true }),
    "transition-timing-function": { handling: "direct", list: true, rule: "U-CSS-008" },
    "user-select": { handling: "dropped" },
    "white-space-collapse": kw("direct", ["collapse", "preserve"]),
    "z-index": { handling: "lowered", rule: "U-CSS-004" },
    // keyframe animations: compiled to keyframe data played at runtime (spec §11); keyframe bodies are U-CSS-013's
    "animation-name": ty("lowered", ["ident"], { list: true }),
    "animation-duration": ty("lowered", ["time"], { list: true }),
    "animation-delay": ty("lowered", ["time"], { list: true }),
    "animation-timing-function": { handling: "lowered", list: true },
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
    "outline-color": ["currentcolor"], "outline-style": ["none"], "outline-width": ["medium"], "outline-offset": ["0px"],
    "text-decoration-line": ["none"], "text-decoration-thickness": ["auto"], "text-decoration-style": ["solid"],
    "text-decoration-color": ["currentcolor"],
    "animation-timeline": ["auto"], "animation-range-start": ["normal"], "animation-range-end": ["normal"],
    "animation-composition": ["replace"], "justify-items": ["normal", "legacy"], "justify-self": ["auto"],
    "text-wrap-style": ["auto"],
  },
  valueFunctions: ["var", "rgb", "rgba", "hsl", "hsla", "linear-gradient", "radial-gradient", "url"],
  transformFunctions: ["translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate"],
  keyframeProperties: ["transform", "translate", "rotate", "scale", "opacity", "color", "background-color", "border-color",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "animation-timing-function"],
  timingKeywords: ["linear", "ease", "ease-in", "ease-out", "ease-in-out"],
  mediaFeatures: ["min-width", "max-width", "min-aspect-ratio", "max-aspect-ratio"],
  layoutTransitionProperties: ["all", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "margin-top",
    "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "top", "right", "bottom", "left", "inset", "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-direction", "flex-wrap",
    "flex-flow"],
  pseudoElements: ["before", "after", "placeholder"],
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
  isTransformFunction(name: string): boolean;
  isKeyframeProperty(name: string): boolean;
  isTimingKeyword(name: string): boolean;
  isMediaFeature(name: string): boolean;
  isLayoutTransitionProperty(name: string): boolean;
  isAllowedPseudoElement(name: string): boolean;
  readonly timingKeywords: readonly string[];
  readonly keyframeProperties: readonly string[];
  readonly mediaFeatures: readonly string[];
}

export function cssSupportFrom(d: CssSupportData): CssSupport {
  const set = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
  const fns = set(d.valueFunctions), tf = set(d.transformFunctions), kf = set(d.keyframeProperties), tk = set(d.timingKeywords);
  const mf = set(d.mediaFeatures), lt = set(d.layoutTransitionProperties), pe = set(d.pseudoElements), units = set(d.units);
  const colors = set(d.colors.keywords);
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
    isTransformFunction: (n) => tf.has(n.toLowerCase()),
    isKeyframeProperty: (n) => kf.has(n.toLowerCase()),
    isTimingKeyword: (n) => tk.has(n.toLowerCase()),
    isMediaFeature: (n) => mf.has(n.toLowerCase()),
    isLayoutTransitionProperty: (n) => lt.has(n.toLowerCase()),
    isAllowedPseudoElement: (n) => pe.has(n.toLowerCase()),
    timingKeywords: d.timingKeywords,
    keyframeProperties: d.keyframeProperties,
    mediaFeatures: d.mediaFeatures,
  };
}

export const cssSupport: CssSupport = cssSupportFrom(CSS_SUPPORT_DATA);
