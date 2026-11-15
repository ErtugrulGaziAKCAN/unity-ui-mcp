import { logicalViewport } from "../../viewport.js";
import { breakpointsHold, declaredViewports } from "../../capture/matrix.js";
import type { KitConfig } from "../../kit.js";
import { drawnPx, minimumKitTextPx, minimumTextPx, TEXT_FLOOR_PX } from "../../kit/textStyles.js";
import { px } from "../css-values.js";
import { breakpointsOf, MediaError, type Breakpoint } from "../resolve/media.js";
import { splitTransform } from "../resolve/transform.js";
import { touchesRuntime } from "../selectors.js";
import type { DomSnapshot } from "../snapshot.js";
import { describeStyle, matchRichStyle, matchTextStyle } from "../text-styles.js";
import type { Rule } from "../types.js";
import { at, Collector, resolved, sources, targetOf, textElements } from "./util.js";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ceil2 = (n: number) => Math.ceil(round6(n * 100)) / 100;

/** The smaller axis factor of a CSS `scale` value ("0.8", "0.8 1", "80%"); 1 for `none`; null when unreadable. */
function scaleValue(v: string): number | null {
  const t = v.trim();
  if (t === "none") return 1;
  const parts = t.split(/\s+/).slice(0, 2).map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
  return parts.length && parts.every(Number.isFinite) ? Math.min(...parts.map(Math.abs)) : null;
}

/** The smaller axis factor of a CSS `transform` value (a computed matrix() or an authored list); 1 without a scale. */
function transformScale(v: string): number | null {
  const t = v.trim();
  if (t === "none") return 1;
  const m = /^matrix\(([^)]*)\)$/.exec(t);
  if (m) {
    const [a, b, c, d] = m[1].split(",").map(Number);
    return [a, b, c, d].every(Number.isFinite) ? Math.min(Math.hypot(a, b), Math.hypot(c, d)) : null;
  }
  const r = splitTransform(t);
  if (!r.ok) return null;
  return r.split.scale ? Math.min(Math.abs(r.split.scale[0]), Math.abs(r.split.scale[1])) : 1;
}

/** A layer's declarations that hide the element: nothing is drawn in that state. */
function hides(decls: readonly { name: string; value: string }[]): boolean {
  return decls.some((d) => {
    const v = d.value.trim().toLowerCase();
    return (d.name === "opacity" && Number(v.endsWith("%") ? v.slice(0, -1) : v) === 0) || (d.name === "visibility" && (v === "hidden" || v === "collapse")) ||
      (d.name === "display" && v === "none");
  });
}

/**
 * The `scale` and `transform` factors of the states an element is drawn in, per property: now (its computed values) and
 * every rule of a state that reaches it and sets either (a hover, an is-* class, a screen state, a breakpoint), whose
 * value replaces only its own property. Rules can apply together (a hover's `scale` with a press's `transform`), so the smallest drawn scale
 * is the smallest `scale` times the smallest `transform` (each is judged with every other). A rule that hides the element
 * (opacity 0, visibility hidden, display none) draws nothing and does not count, nor does a factor of 0; neither do an
 * animation's or a transition's passing frames (only states are judged).
 *
 * An element hidden now is drawn when a rule shows it, or when code does (a dialog, a menu or a toast the design keeps
 * closed): its now values count unless every rule that shows it also sets that property (a pop-in whose closed state is
 * `scale(0)` with opacity 0 is never drawn at its closed scale), and every other rule's values count, since they can
 * apply together with the one that shows it. Null: the element is drawn in no state (nothing to judge).
 */
function drawnFactors(s: DomSnapshot, i: number): { scale: number[]; transform: number[] } | null {
  const e = s.elements[i];
  const nowScale = scaleValue(e.computed["scale"] ?? "none") ?? 1, nowTransform = transformScale(e.computed["transform"] ?? "none") ?? 1;
  const hiddenNow = hides([{ name: "opacity", value: e.computed["opacity"] ?? "1" }, { name: "visibility", value: e.computed["visibility"] ?? "visible" },
    { name: "display", value: e.computed["display"] ?? "block" }]);
  const rules: { sc?: number; tr?: number; shows: boolean }[] = [];
  for (const r of s.rules) {
    const own = r.selectors.filter((x) => !x.pseudoElement && x.elements?.includes(i));
    // a rule of no state applies now: its values are the computed ones
    if (!own.length || (!r.media.length && !own.some((x) => touchesRuntime(x.parsed)))) continue;
    const decls = r.decls.map((d) => ({ name: d.name, value: resolved(s, d.value, i) }));
    if (hides(decls)) continue;
    const sc = decls.find((d) => d.name === "scale"), tr = decls.find((d) => d.name === "transform");
    const shows = decls.some((d) => d.name === "opacity" || d.name === "visibility" || d.name === "display");
    rules.push({ sc: sc ? scaleValue(sc.value) ?? 1 : undefined, tr: tr ? transformScale(tr.value) ?? 1 : undefined, shows });
  }
  const showing = rules.filter((r) => r.shows);
  // now: drawn when visible now, or (hidden now) unless every rule that shows it sets the property itself
  const nowCounts = (own: (r: { sc?: number; tr?: number }) => number | undefined) =>
    !hiddenNow || !showing.length || showing.some((r) => own(r) === undefined);
  const scale = [...(nowCounts((r) => r.sc) ? [nowScale] : []), ...rules.flatMap((r) => (r.sc === undefined ? [] : [r.sc]))].filter((f) => f > 0);
  const transform = [...(nowCounts((r) => r.tr) ? [nowTransform] : []), ...rules.flatMap((r) => (r.tr === undefined ? [] : [r.tr]))].filter((f) => f > 0);
  return scale.length && transform.length ? { scale, transform } : null;
}

/**
 * The smallest scale the element's own and its ancestors' transforms draw it at (1 without any), or null when the
 * element or an ancestor is drawn in no state (nothing to judge).
 */
function minScaleOf(s: DomSnapshot, i: number): number | null {
  let k = 1;
  for (let j = i; j >= 0; j = s.elements[j].parent) {
    const own = drawnFactors(s, j);
    if (!own) return null;
    k *= Math.min(...own.scale) * Math.min(...own.transform);
  }
  return k;
}

/**
 * A `font-size` declared in a layer the current render does not show (a state or a breakpoint), in px at the element:
 * px as written, `em` and `%` of the parent's computed size, `rem` of the root's, `inherit` the parent's; null when it
 * cannot be resolved here (a calc(), a keyword like `smaller`).
 */
function layerFontSize(s: DomSnapshot, i: number, value: string): number | null {
  const v = value.trim().toLowerCase();
  const direct = px(v);
  if (direct !== null) return direct;
  const parent = s.elements[i].parent >= 0 ? px(s.elements[s.elements[i].parent].computed["font-size"]) : s.rootFontSize;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(em|rem|%)$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "rem") return n * s.rootFontSize;
    if (parent === null) return null;
    return m[2] === "em" ? n * parent : (n / 100) * parent;
  }
  if (v === "inherit") return parent;
  return null;
}

/**
 * The readable-text floor: no text draws below TEXT_FLOOR_PX device px at a declared viewport, exact or scaled (the
 * game-industry practice of a minimum readable size instead of looser checks for tiny text; measured,
 * docs/findings/text-ink.md section 9). A text's drawn size is its font size times the smallest scale its transforms
 * draw it at in a state it is drawn in (drawnFactors) times each declared viewport's panel scale; with the default
 * viewports the smallest is 1280×720 (0.5), so design text is at least 18px there. A font size a state or breakpoint layer
 * gives the text (px, em, %, rem) is judged too, a breakpoint's only at the declared viewports where its @media holds. Kit build refuses a kit text style below the floor; this rule names each
 * text that is.
 */
export const rule: Rule = {
  id: "U-FONT-004", severity: "error",
  check(s, kit, _b, ctx) {
    const scales = declaredViewports({ referenceViewport: kit.reference, viewports: kit.viewports })
      .map((v) => ({ v, scale: logicalViewport(v, kit.reference, kit.screenMatch).scale })).sort((a, b) => a.scale - b.scale);
    if (!scales.length) return [];
    const min = minimumTextPx(kit);
    const c = new Collector();
    const texts = textElements(s).filter((e) => e.tag !== "option"); // an option is drawn by the native popup, not the screen
    const isText = new Set(texts.map((e) => e.index));
    const scaleOf = new Map<number, number | null>();
    const k = (i: number) => { if (!scaleOf.has(i)) scaleOf.set(i, minScaleOf(s, i)); return scaleOf.get(i)!; };
    const judge = (i: number, size: number, what: string, where = "", only = scales) => {
      const f = k(i);
      if (f === null || !(size > 0)) return;
      const below = only.filter((x) => size * f * x.scale < TEXT_FLOOR_PX - 1e-9);
      if (!below.length) return;
      const drawn = below.map((x) => `${drawnPx(size * f * x.scale)} device px at ${x.v[0]}×${x.v[1]}`).join(", ");
      c.add(s.elements[i].path, `${what}${f < 1 - 1e-9 ? `, scaled ×${round6(f)} by its transforms,` : ""}${where} draws ${drawn}: below the ` +
        `readable-text floor of ${TEXT_FLOOR_PX} device px; the minimum design size here is ${ceil2(min / f)}px`);
    };
    for (const e of texts) {
      const size = px(e.computed["font-size"]);
      if (size === null) continue;
      const lh = px(e.computed["line-height"]), w = Number(e.computed["font-weight"]);
      const style = matchTextStyle(ctx.textStyles, size, lh, w) ?? matchRichStyle(ctx.textStyles, size, w);
      judge(e.index, size, style ? `text style ${style.name} (${size}px)` : `font-size ${size}px`);
    }
    // font sizes in layers the current render does not show (states, breakpoints), on the text they reach or that inherits them
    for (const src of sources(s)) {
      if (src.kind !== "rule" || !(src.rule!.media.length || src.rule!.selectors.some((x) => x.reach !== x.text))) continue;
      const decl = src.decls.find((d) => d.name === "font-size");
      if (!decl) continue;
      const t = targetOf(s, src);
      if (!t) continue;
      const holding = holdingAt(src.rule!.media, scales, kit);
      if (!holding.length) continue;
      for (const i of src.elements) {
        const value = resolved(s, decl.value, i);
        const decls = src.decls.map((d) => ({ name: d.name, value: resolved(s, d.value, i) }));
        if (hides(decls)) continue;
        const size = layerFontSize(s, i, value);
        const reached = isText.has(i) ? [i] : texts.filter((x) => x.computed["font-size"] === s.elements[i].computed["font-size"] && descends(s, x.index, i)).map((x) => x.index);
        if (size === null) {
          if (reached.length) c.add(s.elements[i].path, `font-size: ${value.trim()}${at(src, t)} cannot be resolved to px here (px, em, %, rem or inherit), so the ` +
            `readable-text floor cannot be judged: write it in px or use a kit text style class`);
          continue;
        }
        for (const x of reached) judge(x, size, `font-size: ${value.trim()} (${round6(size)}px)`, at(src, t), holding);
      }
    }
    const larger = ctx.textStyles.filter((x) => x.fontSize >= min - 1e-9).sort((a, b) => a.fontSize - b.fontSize || a.weight - b.weight)[0];
    const smallest = scales[0];
    return c.findings(rule, `No text may draw below ${TEXT_FLOOR_PX} device px at any declared viewport (the smallest is ` +
      `${smallest.v[0]}×${smallest.v[1]}, scale ${smallest.scale}): use a text style of at least ${min}px` +
      `${larger ? `, such as ${describeStyle(larger)}` : ` (${minimumKitTextPx(kit)}px is whole device px at every exact viewport)`}, ` +
      `in every state, and do not scale text that is drawn below it with a transform.`);
  },
};

/**
 * The declared viewports where a rule's enclosing @media conditions hold (the design's logical size at each, as the
 * capture lays it out); every one for a condition a breakpoint cannot express (U-CSS-012 names it).
 */
function holdingAt<V extends { v: [number, number] }>(media: string[], scales: V[], kit: KitConfig): V[] {
  if (!media.length) return scales;
  let bps: Breakpoint[];
  try {
    const b = breakpointsOf(media);
    if (b.always) return scales;
    bps = b.breakpoints;
  } catch (e) {
    if (e instanceof MediaError) return scales;
    throw e;
  }
  const view = { referenceViewport: kit.reference, screenMatch: kit.screenMatch };
  return scales.filter((x) => bps.some((bp) => breakpointsHold([bp], x.v, view)));
}

/** Whether element `i` is `anc` or inside it. */
function descends(s: DomSnapshot, i: number, anc: number): boolean {
  for (let j = i; j >= 0; j = s.elements[j].parent) if (j === anc) return true;
  return false;
}
