import { px } from "../css-values.js";
import type { Rule } from "../types.js";
import { kitScales } from "./U-CSS-040.js";
import { declRule } from "./util.js";

/**
 * The lengths UI Toolkit puts on whole device pixels before layout (halves up), measured in Unity 6000.3
 * (docs/findings/viewport-classes.md, `ViewportScaleTextTests.LengthsUiToolkitSnaps_…` and `BoxModelLengths_…`): padding and
 * margin (a gap is compiled into the later children's margins). Border widths are U-CSS-040's. Position offsets (left,
 * right, top, bottom), translate, widths and heights are laid out as given.
 */
const SNAPPED = /^(padding|margin)-(top|right|bottom|left)$|^(row-|column-)?gap$/;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The nearest lengths below and above `v` (whole CSS px, the reference's scale is 1) that are whole device px at every scale. */
export function nearestWhole(v: number, scales: number[]): [number | null, number | null] {
  const ok = (w: number) => scales.every((s) => Number.isInteger(round6(w * s)));
  const a = Math.abs(v), sign = v < 0 ? -1 : 1;
  let below: number | null = null, above: number | null = null;
  for (let w = Math.floor(a); w >= 0; w--) if (ok(w)) { below = w; break; }
  for (let w = Math.ceil(a); w <= Math.ceil(a) + 256; w++) if (w !== a && ok(w)) { above = w; break; }
  return sign < 0 ? [above === null ? null : -above, below === null ? null : -below] : [below, above];
}

/**
 * Box-model lengths on the device grid at every exact viewport: UI Toolkit lays a padding, margin or gap out as whole device
 * pixels (rounding halves up) where Chromium lays out the fraction, so at 1920×1080 (0.75) a 10 px padding is 8 device px in
 * Unity and 7.5 in the design, and everything inside or after it moves half a pixel; text inside such a box is drawn about a
 * device pixel off the design's. Scaled viewports are exempt (their own route keeps them within the limits).
 */
export const rule: Rule = {
  id: "U-CSS-046", severity: "error",
  check(s, kit) {
    const scales = kitScales(kit);
    const where = scales.map((x) => `${x.viewport[0]}×${x.viewport[1]}`).join(", ");
    const fix = `Use paddings, margins and gaps that are a whole number of device pixels at every exact viewport the kit ` +
      `declares (${where}): multiples of 4px with the default kit. UI Toolkit lays these lengths out as whole device ` +
      `pixels, rounding halves up, where the browser lays out the fraction, so everything inside or after the box moves by ` +
      `up to half a pixel and its text by about one.`;
    return declRule(s, rule, fix, (d, v, _src, t) => {
      if (!SNAPPED.test(d.name)) return null;
      const raw = v.trim().toLowerCase();
      if (raw === "auto" || raw === "normal" || raw === "0") return null;
      // rem and em resolve like the exporter's computed lengths; a percentage takes the element's computed length
      const rel = /^(-?(?:\d+\.?\d*|\.\d+))(r?em)$/.exec(raw);
      const em = rel ? (rel[2] === "rem" ? s.rootFontSize : px(t.element?.computed["font-size"]) ?? s.rootFontSize) : 0;
      let length = rel ? Number(rel[1]) * em : px(raw);
      if (length === null && raw.endsWith("%") && t.element) length = px(t.element.computed[d.name.replace(/^gap$/, "row-gap")]);
      if (length === null || length === 0) return null;
      const off = scales.filter((x) => !Number.isInteger(round6(length! * x.scale)));
      if (!off.length) return null;
      const at = off.map((x) => `${round6(length! * x.scale)} device px at ${x.viewport[0]}×${x.viewport[1]}`).join(", ");
      const [below, above] = nearestWhole(length, scales.map((x) => x.scale));
      const nearest = [below, above].filter((n): n is number => n !== null).map((n) => `${n}px`).join(" or ");
      return `${d.via && !d.invalid ? `${d.name} (from ${d.via})` : d.name}: ${v.trim()} is ${at} (UI Toolkit lays it out as whole device px); ` +
        `nearest whole at every exact viewport: ${nearest}`;
    }, { pseudo: true });
  },
};
