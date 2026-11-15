import { logicalViewport } from "../../viewport.js";
import { breakpointsHold, declaredViewports } from "../../capture/matrix.js";
import type { KitConfig } from "../../kit.js";
import { drawnPx, minimumKitTextPx, minimumTextPx, TEXT_FLOOR_PX } from "../../kit/textStyles.js";
import { px } from "../css-values.js";
import { breakpointsOf, MediaError, type Breakpoint } from "../resolve/media.js";
import { splitTransform } from "../resolve/transform.js";
import { runtimeConditions, touchesRuntime } from "../selectors.js";
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

/** The runtime conditions of a rule's selector (runtimeConditions): what must hold, and be absent, for it to apply. */
type Cond = { pos: Set<string>; neg: Set<string> };
/** Two rules can apply at once unless one needs a condition the other needs absent (`.is-open` and `:not(.is-open)`). */
const together = (a: Cond, b: Cond) => ![...a.pos].some((x) => b.neg.has(x)) && ![...a.neg].some((x) => b.pos.has(x));
/** `b` applies whenever `a` does: it needs no condition `a` does not (the same state, or less of it). */
const implied = (b: Cond, a: Cond) => [...b.pos].every((x) => a.pos.has(x)) && [...b.neg].every((x) => a.neg.has(x));

/**
 * What a rule's animation leaves on the element once it ends, when it keeps its end (`animation-fill-mode` forwards or
 * both): the last keyframe's declarations of each such animation; empty when none does.
 */
function animationEnd(s: DomSnapshot, decls: readonly { name: string; value: string }[]): { name: string; value: string }[] {
  const names = (decls.find((d) => d.name === "animation-name")?.value ?? "").split(",").map((x) => x.trim());
  const fills = (decls.find((d) => d.name === "animation-fill-mode")?.value ?? "none").split(",").map((x) => x.trim());
  const out: { name: string; value: string }[] = [];
  names.forEach((name, k) => {
    const fill = fills[k % fills.length] ?? "none";
    if (!name || name === "none" || (fill !== "forwards" && fill !== "both")) return;
    const frames = s.keyframes.filter((x) => x.name === name).at(-1)?.frames ?? [];
    for (const f of frames) if (f.key.split(",").some((k2) => ["100%", "to"].includes(k2.trim()))) out.push(...f.decls.map((d) => ({ name: d.name, value: d.value })));
  });
  return out;
}

/**
 * The `scale` and `transform` factors of the states an element is drawn in, per property: now (its computed values) and
 * every rule of a state that reaches it and sets either (a hover, an is-* class, a screen state, a breakpoint), whose
 * value replaces only its own property. Rules can apply together (a hover's `scale` with a press's `transform`), so the smallest drawn scale
 * is the smallest `scale` times the smallest `transform` (each is judged with every other). A rule that hides the element
 * (opacity 0, visibility hidden, display none) draws nothing and does not count, nor does a factor of 0; neither do an
 * animation's or a transition's passing frames (only states are judged); an animation that keeps its end (fill forwards or
 * both) leaves its last keyframe's values while its rule applies. A rule of no state counts when a state rule sets the same
 * property and its value is not the one shown now (`.box{transform:scale(.5)} .box:not(.is-open){transform:none}`: drawn
 * at 0.5 when open).
 *
 * An element hidden now is drawn when a rule shows it (a value of opacity, visibility or display that is not hidden, or an
 * animation that ends visible), or when code does (a dialog, a menu or a toast the design keeps closed). Its now values count
 * unless every rule that shows it comes with a rule of its state (one that applies whenever it does, the same rule too)
 * that sets that property (a pop-in whose closed state is `scale(0)` with opacity 0 is never drawn at its closed scale), or
 * unless they come from a state rule that cannot apply together with any rule that shows it (`:not(.is-open)`). Every other
 * rule's values count when it can apply together with a rule that shows it. Null: the element is drawn in no state.
 */
function drawnFactors(s: DomSnapshot, i: number): { scale: number[]; transform: number[] } | null {
  const e = s.elements[i];
  const nowScale = scaleValue(e.computed["scale"] ?? "none") ?? 1, nowTransform = transformScale(e.computed["transform"] ?? "none") ?? 1;
  const hiddenNow = hides([{ name: "opacity", value: e.computed["opacity"] ?? "1" }, { name: "visibility", value: e.computed["visibility"] ?? "visible" },
    { name: "display", value: e.computed["display"] ?? "block" }]);
  type Entry = { sc?: number; tr?: number; shows: boolean; cond: Cond };
  const rules: Entry[] = [], base: { sc?: number; tr?: number }[] = [];
  for (const r of s.rules) {
    const own = r.selectors.filter((x) => !x.pseudoElement && x.elements?.includes(i));
    if (!own.length) continue;
    const decls = r.decls.map((d) => ({ name: d.name, value: resolved(s, d.value, i) }));
    if (hides(decls)) continue;
    const end = animationEnd(s, decls);
    const last = (name: string) => [...end].reverse().find((d) => d.name === name);
    const sc = decls.find((d) => d.name === "scale") ?? last("scale"), tr = decls.find((d) => d.name === "transform") ?? last("transform");
    const value = { sc: sc ? scaleValue(sc.value) ?? 1 : undefined, tr: tr ? transformScale(tr.value) ?? 1 : undefined };
    // a rule of no state applies now: its values are the computed ones, unless a state rule replaces them now (below)
    if (!r.media.length && !own.some((x) => touchesRuntime(x.parsed))) { base.push(value); continue; }
    const shows = decls.some((d) => d.name === "opacity" || d.name === "visibility" || d.name === "display") ||
      (end.length > 0 && !hides(end) && end.some((d) => d.name === "opacity" || d.name === "visibility" || d.name === "display"));
    for (const x of own) rules.push({ ...value, shows, cond: runtimeConditions(x.parsed) });
  }
  const showing = rules.filter((r) => r.shows);
  // whether a condition holds in the render the snapshot shows: markup classes on the element or an ancestor (no pointer)
  const classes = (j: number) => (s.elements[j].attrs["class"] ?? "").split(/\s+/);
  const holds = (token: string): boolean => {
    const self = token.startsWith("s:"), t = token.slice(2);
    if (!t.startsWith(".")) return false;
    if (self) return classes(i).includes(t.slice(1));
    for (let j = e.parent; j >= 0; j = s.elements[j].parent) if (classes(j).includes(t.slice(1))) return true;
    return false;
  };
  const holdsNow = (c: Cond) => [...c.pos].every(holds) && ![...c.neg].some(holds);
  // a rule's values count when the element is drawn while it applies: always when visible now, else with a rule that shows it
  const drawnWith = (c: Cond) => !hiddenNow || !showing.length || showing.some((a) => together(a.cond, c));
  type Pick = (r: { sc?: number; tr?: number }) => number | undefined;
  const nowCounts = (own: Pick) => {
    if (!hiddenNow || !showing.length) return true;
    // the now value from a state rule that applies now: only when that rule can apply with a rule that shows the element
    const from = rules.filter((r) => own(r) !== undefined && holdsNow(r.cond));
    if (from.length && !from.some((r) => drawnWith(r.cond))) return false;
    return showing.some((a) => !rules.some((b) => own(b) !== undefined && implied(b.cond, a.cond)));
  };
  const collect = (now: number, own: Pick) => {
    const stated = rules.filter((r) => own(r) !== undefined);
    return [
      ...(nowCounts(own) ? [now] : []),
      ...stated.filter((r) => drawnWith(r.cond)).map((r) => own(r)!),
      // a rule of no state whose value a state rule replaces now applies in the states that rule does not
      ...(stated.length ? base.map(own).filter((v): v is number => v !== undefined && Math.abs(v - now) > 1e-9) : []),
    ].filter((f) => f > 0);
  };
  const scale = collect(nowScale, (r) => r.sc), transform = collect(nowTransform, (r) => r.tr);
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
