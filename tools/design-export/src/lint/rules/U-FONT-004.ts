import { logicalViewport } from "../../viewport.js";
import { declaredViewports } from "../../capture/matrix.js";
import { drawnPx, minimumKitTextPx, minimumTextPx, TEXT_FLOOR_PX } from "../../kit/textStyles.js";
import { px } from "../css-values.js";
import { splitTransform } from "../resolve/transform.js";
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
 * The scales an element's own transforms draw it at, one per state it is drawn in: now (its computed `scale` times
 * `transform`) and in every rule that reaches it and sets either (a hover, a class, a screen state, a breakpoint), where
 * the rule's value replaces only its own property and multiplies with the other's. A state that hides the element
 * (opacity 0, visibility hidden, display none; for a rule, also the hiding it keeps from now) or scales it to 0 draws
 * nothing and does not count; neither do an animation's or a transition's passing frames (only states are judged).
 */
function drawnScales(s: DomSnapshot, i: number): number[] {
  const e = s.elements[i];
  const nowScale = scaleValue(e.computed["scale"] ?? "none") ?? 1, nowTransform = transformScale(e.computed["transform"] ?? "none") ?? 1;
  const hiddenNow = hides([{ name: "opacity", value: e.computed["opacity"] ?? "1" }, { name: "visibility", value: e.computed["visibility"] ?? "visible" },
    { name: "display", value: e.computed["display"] ?? "block" }]);
  const out: number[] = [];
  if (!hiddenNow && nowScale * nowTransform > 0) out.push(nowScale * nowTransform);
  for (const r of s.rules) {
    if (!r.selectors.some((x) => !x.pseudoElement && x.elements?.includes(i))) continue;
    const decls = r.decls.map((d) => ({ name: d.name, value: resolved(s, d.value, i) }));
    const sc = decls.find((d) => d.name === "scale"), tr = decls.find((d) => d.name === "transform");
    if (!sc && !tr) continue;
    if (hides(decls)) continue;
    // a rule that sets no visibility of its own keeps the element as hidden as it is now
    const showsItself = decls.some((d) => d.name === "opacity" || d.name === "visibility" || d.name === "display");
    if (hiddenNow && !showsItself) continue;
    const f = (sc ? scaleValue(sc.value) ?? 1 : nowScale) * (tr ? transformScale(tr.value) ?? 1 : nowTransform);
    if (f > 0) out.push(f);
  }
  return out;
}

/**
 * The smallest scale the element's own and its ancestors' transforms draw it at (1 without any), or null when the
 * element or an ancestor is drawn in no state (nothing to judge).
 */
function minScaleOf(s: DomSnapshot, i: number): number | null {
  let k = 1;
  for (let j = i; j >= 0; j = s.elements[j].parent) {
    const own = drawnScales(s, j);
    if (!own.length) return null;
    k *= Math.min(...own);
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
 * draw it at in a state it is drawn in (drawnScales) times each declared viewport's panel scale; with the default
 * viewports the smallest is 1280×720 (0.5), so design text is at least 18px there. A font size a state or breakpoint layer
 * gives the text (px, em, %, rem) is judged too. Kit build refuses a kit text style below the floor; this rule names each
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
    const judge = (i: number, size: number, what: string, where = "") => {
      const f = k(i);
      if (f === null || !(size > 0)) return;
      const below = scales.filter((x) => size * f * x.scale < TEXT_FLOOR_PX - 1e-9);
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
        for (const x of reached) judge(x, size, `font-size: ${value.trim()} (${round6(size)}px)`, at(src, t));
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

/** Whether element `i` is `anc` or inside it. */
function descends(s: DomSnapshot, i: number, anc: number): boolean {
  for (let j = i; j >= 0; j = s.elements[j].parent) if (j === anc) return true;
  return false;
}
