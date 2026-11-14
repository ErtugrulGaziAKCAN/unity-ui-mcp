/**
 * The CSS the pipeline supports, in one place: the Unity package's `Editor/Data/css-support.json`, which the Unity
 * style mapper reads too. Rules read it only through `cssSupport`.
 *
 * The file describes IR values for the mapper (handling, keywords, types, functions, lowered values) and adds what the
 * lint needs on top: rule ids and fixes per rejected value (`rejectedValues`, `valueRule`, `valueFix`), authoring-level
 * overrides for values the exporter rewrites before the IR (`authoring`, `exportResolved`), initial values and the
 * auxiliary lists (pseudo-classes, elements, at-rules, …). This module derives the lint's authoring-level view.
 *
 * handling: direct = written to USS; lowered = rewritten before mapping (gap → margins, z-index → order, display:
 * block → column, transform → translate/rotate/scale at export); dropped = accepted and omitted (baked by the exporter,
 * or no effect in UI Toolkit); error = never supported.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CSS_WIDE } from "./css-values.js";

export type Handling = "direct" | "lowered" | "dropped" | "error";
export interface Rejection { rule: string; fix: string }

/** One property as css-support.json records it. */
export interface CssSupportEntry {
  handling: Handling;
  keywords?: string[];
  types?: string[];
  functions?: string[];
  list?: boolean;
  components?: [number, number];
  dropValues?: string[];
  loweredValues?: string[];
  loweredFunctions?: string[];
  mapValues?: Record<string, string>;
  /** Rule and fix of an error property. */
  rule?: string;
  fix?: string;
  /** Keywords a dedicated lint rule rejects, with that rule and its fix. */
  rejectedValues?: Record<string, Rejection>;
  /** A dedicated lint rule judges the values (U-CSS-023 checks neither keywords nor units). */
  valueRule?: string;
  /** Fix for any other rejected value. */
  valueFix?: string;
  /** Authoring-level overrides: the exporter rewrites the value before the IR. */
  authoring?: { handling?: Handling; keywords?: string[]; types?: string[]; list?: boolean; note?: string };
  note?: string;
}

/** Lint data besides the properties (shared by both views). */
interface Lists {
  /** CSS initial values (as Chromium serialises them) of longhands that shorthands write; never flagged. */
  initialValues: Record<string, string[]>;
  /** SVG presentation properties: allowed on elements inside an inline <svg>, which is exported as a vector asset. */
  svgPresentation: string[];
  transformFunctions: string[];
  keyframeProperties: string[];
  timingKeywords: string[];
  /** Easing functions with arguments the animation player evaluates (cubic-bezier, steps). */
  timingFunctions: string[];
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

/** css-support.json as written. */
export interface CssSupportFile extends Lists {
  version: number;
  /** Length and percent units of IR values (the Unity mapper's units). */
  units: string[];
  colors: { hex: boolean; functions: string[]; keywords: string[] };
  /** Units of each value type the mapper accepts. */
  typeUnits: Record<string, string[]>;
  /** Authoring forms the exporter resolves before the IR. */
  exportResolved: { units: string[]; functions: string[]; colorFunctions: string[]; keywords: string[]; note: string };
  notes: Record<string, string>;
  properties: Record<string, CssSupportEntry>;
}

/** A property as the lint sees it (authoring level). */
export interface PropertySupport {
  handling: Handling;
  /** How the Unity mapper handles the property in the IR. */
  irHandling: Handling;
  /** Accepted keywords (lowered and dropped values included); absent when any keyword passes the keyword check. */
  keywords?: string[];
  /** Value types besides the keywords (length, percent, number, color, angle, time, ratio, ident, string). */
  types?: string[];
  /** Keyword aliases the compiler rewrites (accepted as is). */
  mapValues?: Record<string, string>;
  /** Comma-separated list allowed. */
  list?: boolean;
  /** The rule that judges the values (`valueRule`), or the rule of an error property. */
  rule?: string;
  /** A dedicated rule judges the values; U-CSS-023 checks neither keywords nor units. */
  valueRule?: string;
  /** Keywords another rule rejects (`rejected`), so U-CSS-023 does not report them twice. */
  owns?: string[];
  rejected?: Record<string, Rejection>;
  /** Fix of an error property. */
  fix?: string;
  /** Fix for a rejected value. */
  valueFix?: string;
}

export interface CssSupportData extends Lists {
  version: number;
  /** Units the lint accepts (the mapper's, plus the units of every value type and the ones resolved at export). */
  units: string[];
  colors: { functions: string[]; keywords: string[] };
  properties: Record<string, PropertySupport>;
  valueFunctions: string[];
}

export const CSS_SUPPORT_FILE = fileURLToPath(new URL("../../../../packages/com.unity.design-ui/Editor/Data/css-support.json", import.meta.url));

export function readCssSupportFile(file = CSS_SUPPORT_FILE): CssSupportFile {
  return JSON.parse(fs.readFileSync(file, "utf8")) as CssSupportFile;
}

const uniq = (xs: (string | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => !!x)));

/** The lint's authoring-level view of one property. */
export function propertyView(e: CssSupportEntry): PropertySupport {
  const handling = e.authoring?.handling ?? e.handling;
  const kws = uniq([...(e.keywords ?? []), ...(e.loweredValues ?? []), ...(e.dropValues ?? []), ...(e.authoring?.keywords ?? [])]);
  const types = uniq([...(e.types ?? []), ...(e.authoring?.types ?? [])]);
  const p: PropertySupport = { handling, irHandling: e.handling };
  // a property with value types but no keyword accepts no keyword (padding: auto is not a length)
  if (kws.length || types.length) p.keywords = kws;
  if (types.length) p.types = types;
  if (e.mapValues) p.mapValues = e.mapValues;
  if (e.list || e.authoring?.list) p.list = true;
  const rule = e.valueRule ?? (e.handling === "error" ? e.rule : undefined);
  if (rule) p.rule = rule;
  if (e.valueRule) p.valueRule = e.valueRule;
  if (e.rejectedValues) { p.rejected = e.rejectedValues; p.owns = Object.keys(e.rejectedValues); }
  if (e.handling === "error" && e.fix) p.fix = e.fix;
  if (e.valueFix) p.valueFix = e.valueFix;
  return p;
}

export function cssSupportDataFrom(f: CssSupportFile): CssSupportData {
  const props = Object.values(f.properties);
  return {
    version: f.version,
    units: uniq([...f.units, ...Object.values(f.typeUnits).flat(), ...f.exportResolved.units]),
    colors: { functions: uniq([...f.colors.functions, ...f.exportResolved.colorFunctions]), keywords: f.colors.keywords },
    properties: Object.fromEntries(Object.entries(f.properties).map(([n, e]) => [n, propertyView(e)])),
    valueFunctions: uniq([...f.exportResolved.functions, ...f.colors.functions, ...f.exportResolved.colorFunctions,
      ...props.flatMap((e) => [...(e.functions ?? []), ...(e.loweredFunctions ?? [])])]),
    initialValues: f.initialValues, svgPresentation: f.svgPresentation, transformFunctions: f.transformFunctions,
    keyframeProperties: f.keyframeProperties, timingKeywords: f.timingKeywords, timingFunctions: f.timingFunctions, mediaFeatures: f.mediaFeatures, mediaTypes: f.mediaTypes,
    layoutTransitionProperties: f.layoutTransitionProperties, pseudoElements: f.pseudoElements, pseudoClasses: f.pseudoClasses,
    atRules: f.atRules, elements: f.elements, inputTypes: f.inputTypes, browserDefaults: f.browserDefaults,
  };
}

export const CSS_SUPPORT_JSON: CssSupportFile = readCssSupportFile();
export const CSS_SUPPORT_DATA: CssSupportData = cssSupportDataFrom(CSS_SUPPORT_JSON);

/**
 * The filter functions css-support.json enables (the Unity mapper writes them): `filter`'s `functions`, none while its
 * handling is "error". The only source of U-CSS-015's allow-list; kit build mirrors it into kit.config.json.
 */
export function enabledFilterFunctions(f: CssSupportFile = CSS_SUPPORT_JSON): string[] {
  const e = f.properties.filter;
  return !e || e.handling === "error" ? [] : (e.functions ?? []).map((x) => x.toLowerCase());
}

/** U-CSS-023's fix when the property names none of its own. */
export const GENERIC_FIX = "Remove the property or value, or express it with supported CSS: the properties, keywords and units of RULES.md in the design kit (spec §5.3); lengths in px, % or rem; colours as hex, rgb()/rgba(), hsl()/hsla() or the basic named colours.";

export interface CssSupport {
  property(name: string): PropertySupport | null;
  /** Listed with a handling other than "error". */
  isAllowedProperty(name: string): boolean;
  /** Keywords the property accepts (aliases included), or null when its keywords are unconstrained. */
  allowedValuesFor(name: string): readonly string[] | null;
  /** The value equals the property's CSS initial value (what a shorthand writes for an omitted part). */
  isInitialValue(name: string, value: string): boolean;
  /** A keyword a dedicated rule rejects, with that rule and fix. */
  rejection(name: string, keyword: string): Rejection | null;
  /** The fix for a rejected value of the property (or for the rejected property itself). */
  fixFor(name: string): string;
  /**
   * A declaration the exporter leaves out of the IR: a CSS-wide keyword or an initial value of a property that is not
   * listed or that the mapper rejects (filter: none, float: none, text-transform: none).
   */
  omittedAtExport(name: string, value: string): boolean;
  isAllowedFunction(name: string): boolean;
  isAllowedUnit(unit: string): boolean;
  isAllowedColorKeyword(word: string): boolean;
  isSvgPresentation(name: string): boolean;
  isTransformFunction(name: string): boolean;
  isKeyframeProperty(name: string): boolean;
  isTimingKeyword(name: string): boolean;
  /**
   * A CSS easing the animation player evaluates exactly: a timing keyword, `cubic-bezier(x1, y1, x2, y2)` with x1 and x2
   * in [0, 1], or `steps(n[, jump-start | jump-end | jump-none | jump-both | start | end])` (jump-none needs n ≥ 2).
   */
  isTimingFunction(text: string): boolean;
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
  readonly timingFunctions: readonly string[];
  readonly keyframeProperties: readonly string[];
  readonly mediaFeatures: readonly string[];
  readonly pseudoClasses: readonly string[];
  readonly elements: readonly string[];
  readonly inputTypes: readonly string[];
}

export function cssSupportFrom(d: CssSupportData): CssSupport {
  const set = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
  const fns = set(d.valueFunctions), tf = set(d.transformFunctions), kf = set(d.keyframeProperties), tk = set(d.timingKeywords), tfn = set(d.timingFunctions);
  const mf = set(d.mediaFeatures), mt = set(d.mediaTypes), lt = set(d.layoutTransitionProperties), pe = set(d.pseudoElements);
  const units = set(d.units), colors = set(d.colors.keywords), svg = set(d.svgPresentation), pc = set(d.pseudoClasses);
  const els = set(d.elements), types = set(d.inputTypes);
  const isInitialValue = (n: string, v: string) => v.trim().toLowerCase() === "initial" || (d.initialValues[n] ?? []).includes(v.trim().toLowerCase());
  return {
    property: (n) => d.properties[n] ?? null,
    isAllowedProperty: (n) => !!d.properties[n] && d.properties[n].handling !== "error",
    allowedValuesFor: (n) => {
      const p = d.properties[n];
      if (!p?.keywords) return null;
      return [...p.keywords, ...Object.keys(p.mapValues ?? {})];
    },
    isInitialValue,
    rejection: (n, k) => d.properties[n]?.rejected?.[k.trim().toLowerCase()] ?? null,
    fixFor: (n) => d.properties[n]?.valueFix ?? d.properties[n]?.fix ?? GENERIC_FIX,
    omittedAtExport: (n, v) => {
      const p = d.properties[n];
      return (!p || p.handling === "error") && (CSS_WIDE.has(v.trim().toLowerCase()) || isInitialValue(n, v));
    },
    isAllowedFunction: (n) => fns.has(n.toLowerCase()),
    isAllowedUnit: (u) => u === "" || units.has(u.toLowerCase()),
    isAllowedColorKeyword: (w) => colors.has(w.toLowerCase()),
    isSvgPresentation: (n) => svg.has(n.toLowerCase()),
    isTransformFunction: (n) => tf.has(n.toLowerCase()),
    isKeyframeProperty: (n) => kf.has(n.toLowerCase()),
    isTimingKeyword: (n) => tk.has(n.toLowerCase()),
    isTimingFunction: (text) => timingFunctionOk(text, tk, tfn),
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
    timingFunctions: d.timingFunctions,
    keyframeProperties: d.keyframeProperties,
    mediaFeatures: d.mediaFeatures,
    pseudoClasses: d.pseudoClasses,
    elements: d.elements,
    inputTypes: d.inputTypes,
  };
}

/** See CssSupport.isTimingFunction (the player's DesignTimingFunction.TryParse accepts the same). */
function timingFunctionOk(text: string, keywords: Set<string>, functions: Set<string>): boolean {
  const t = text.trim().toLowerCase();
  if (keywords.has(t)) return true;
  const m = /^([a-z-]+)\((.*)\)$/.exec(t);
  if (!m || !functions.has(m[1])) return false;
  const args = m[2].split(",").map((x) => x.trim());
  const num = (x: string) => (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(x) ? Number(x) : NaN);
  if (m[1] === "cubic-bezier") {
    if (args.length !== 4) return false;
    const n = args.map(num);
    return n.every(Number.isFinite) && n[0] >= 0 && n[0] <= 1 && n[2] >= 0 && n[2] <= 1;
  }
  if (m[1] === "steps") {
    if (args.length < 1 || args.length > 2 || !/^\d+$/.test(args[0])) return false;
    const count = Number(args[0]), pos = args[1] ?? "jump-end";
    if (!["jump-start", "jump-end", "jump-none", "jump-both", "start", "end"].includes(pos)) return false;
    return count >= (pos === "jump-none" ? 2 : 1);
  }
  return false;
}

export const cssSupport: CssSupport = cssSupportFrom(CSS_SUPPORT_DATA);
