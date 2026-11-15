import { logicalViewport } from "../../viewport.js";
import { declaredViewports } from "../../capture/matrix.js";
import { drawnPx, minimumKitTextPx, minimumTextPx, TEXT_FLOOR_PX } from "../../kit/textStyles.js";
import { px } from "../css-values.js";
import { splitTransform } from "../resolve/transform.js";
import type { DomSnapshot } from "../snapshot.js";
import { describeStyle, matchRichStyle, matchTextStyle } from "../text-styles.js";
import type { Rule } from "../types.js";
import { Collector, textElements } from "./util.js";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The smaller axis factor of a CSS `scale` value ("0.8", "0.8 1", "80%"), or null. */
function scaleValue(v: string | undefined): number | null {
  if (!v || v.trim() === "none") return null;
  const parts = v.trim().split(/\s+/).slice(0, 2).map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
  return parts.length && parts.every(Number.isFinite) ? Math.min(...parts.map(Math.abs)) : null;
}

/** The smaller axis factor of a CSS `transform` value (a computed matrix() or an authored list), or null. */
function transformScale(v: string | undefined): number | null {
  if (!v || v.trim() === "none") return null;
  const m = /^matrix\(([^)]*)\)$/.exec(v.trim());
  if (m) {
    const [a, b, c, d] = m[1].split(",").map(Number);
    return [a, b, c, d].every(Number.isFinite) ? Math.min(Math.hypot(a, b), Math.hypot(c, d)) : null;
  }
  const r = splitTransform(v);
  return r.ok && r.split.scale ? Math.min(Math.abs(r.split.scale[0]), Math.abs(r.split.scale[1])) : null;
}

/**
 * The smallest scale an element's own transforms keep it at: its computed `scale` and `transform` now, and any `scale` or
 * `transform` a rule that reaches it gives it in a state (hover, a class, a screen state). Animations pass through their
 * frames, so keyframes do not count.
 */
function ownMinScale(s: DomSnapshot, i: number): number {
  const e = s.elements[i];
  let now = 1;
  const sv = scaleValue(e.computed["scale"]), tv = transformScale(e.computed["transform"]);
  if (sv !== null) now *= sv;
  if (tv !== null) now *= tv;
  let least = now;
  for (const r of s.rules) {
    if (!r.selectors.some((x) => x.elements?.includes(i))) continue;
    for (const d of r.decls) {
      const f = d.name === "scale" ? scaleValue(d.value) : d.name === "transform" ? transformScale(d.value) : null;
      if (f !== null) least = Math.min(least, f);
    }
  }
  return least;
}

/** The smallest scale the element's own and its ancestors' transforms keep it at (1 without any). */
function minScaleOf(s: DomSnapshot, i: number): number {
  let k = 1;
  for (let j = i; j >= 0; j = s.elements[j].parent) k *= ownMinScale(s, j);
  return k;
}

/**
 * The readable-text floor: no text draws below TEXT_FLOOR_PX device px at a declared viewport, exact or scaled (the
 * game-industry practice of a minimum readable size instead of looser checks for tiny text; measured,
 * docs/findings/text-ink.md section 9). A text's drawn size is its font size times the scale its transforms keep it at
 * times each declared viewport's panel scale; with the default viewports the smallest is 1280×720 (0.5), so design text
 * is at least 18px there. Kit build refuses a kit text style below the floor; this rule names each text that is.
 */
export const rule: Rule = {
  id: "U-FONT-004", severity: "error",
  check(s, kit, _b, ctx) {
    const scales = declaredViewports({ referenceViewport: kit.reference, viewports: kit.viewports })
      .map((v) => ({ v, scale: logicalViewport(v, kit.reference, kit.screenMatch).scale })).sort((a, b) => a.scale - b.scale);
    if (!scales.length) return [];
    const min = minimumTextPx(kit);
    const c = new Collector();
    for (const e of textElements(s)) {
      if (e.tag === "option") continue; // drawn by the native popup, not the screen
      const size = px(e.computed["font-size"]);
      if (size === null || size <= 0) continue;
      const k = minScaleOf(s, e.index);
      const below = scales.filter((x) => size * k * x.scale < TEXT_FLOOR_PX - 1e-9);
      if (!below.length) continue;
      const lh = px(e.computed["line-height"]), w = Number(e.computed["font-weight"]);
      const style = matchTextStyle(ctx.textStyles, size, lh, w) ?? matchRichStyle(ctx.textStyles, size, w);
      const what = style ? `text style ${style.name} (${size}px)` : `font-size ${size}px`;
      const at = below.map((x) => `${drawnPx(size * k * x.scale)} device px at ${x.v[0]}×${x.v[1]}`).join(", ");
      c.add(e.path, `${what}${k < 1 - 1e-9 ? `, scaled ×${round6(k)} by its transforms,` : ""} draws ${at}: below the readable-text floor of ` +
        `${TEXT_FLOOR_PX} device px; the minimum design size here is ${Math.ceil(round6((min / k) * 100)) / 100}px`);
    }
    const larger = ctx.textStyles.filter((x) => x.fontSize >= min - 1e-9).sort((a, b) => a.fontSize - b.fontSize || a.weight - b.weight)[0];
    const smallest = scales[0];
    return c.findings(rule, `No text may draw below ${TEXT_FLOOR_PX} device px at any declared viewport (the smallest is ` +
      `${smallest.v[0]}×${smallest.v[1]}, scale ${smallest.scale}): use a text style of at least ${min}px` +
      `${larger ? `, such as ${describeStyle(larger)}` : ` (${minimumKitTextPx(kit)}px is whole device px at every exact viewport)`}, ` +
      `and do not scale text below it with a transform.`);
  },
};
