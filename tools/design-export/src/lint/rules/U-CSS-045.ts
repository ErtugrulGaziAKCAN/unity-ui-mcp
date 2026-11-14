import { layoutOf } from "../layout.js";
import { px } from "../css-values.js";
import type { Rule } from "../types.js";
import { isTextElement } from "../text-runs.js";
import { Collector } from "./util.js";

const FIX = "Give the box a width (a px width, or a % of a sized parent) instead of letting max-width set it, or let the " +
  "text fit on one line. UI Toolkit measures a box that max-width limits at its longest wrapped line (Chromium at the " +
  "max-width), so the box comes out narrower and its neighbours move.";

const lineHeight = (v: string | undefined, fontSize: string | undefined) =>
  px(v) ?? (v === "normal" ? 1.2 * (px(fontSize) ?? 16) : NaN);

/**
 * A box whose width a max-width sets while its text wraps. Chromium sizes an auto-width box to its max-content width
 * and clamps that at the max-width; UI Toolkit's layout measures the box with the max-width as the most it may take,
 * and the text answers with its longest wrapped line (measured: a 260 px capped chip of wrapping body text is 256 px
 * in Unity, at every viewport). A width of its own, a stretched cross size or a flex-grow give the box a definite
 * size and are fine; so is a max-width the box does not reach.
 */
export const rule: Rule = {
  id: "U-CSS-045", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const wraps = (i: number): boolean => {
      const e = s.elements[i];
      if (e.rendered && e.size && isTextElement(s, e)) {
        const lh = lineHeight(e.computed["line-height"], e.computed["font-size"]);
        const pad = ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"].reduce((a, p) => a + (px(e.computed[p]) ?? 0), 0);
        if (lh > 0 && e.size.h - pad > 1.5 * lh) return true;
      }
      return L.children(i).some(wraps);
    };
    for (const e of s.elements) {
      if (!L.inScreen(e.index) || e.ns !== "html" || !e.rendered || !e.size) continue;
      const base = (p: string) => L.ex.effective(e.index, [], p)?.entry.value.trim();
      const max = base("max-width");
      if (!max || max === "none") continue;
      const own = base("width"), grow = parseFloat(base("flex-grow") ?? "0");
      if ((own && own !== "auto") || grow > 0) continue;
      const parent = s.elements[e.parent];
      const pd = parent?.computed ?? {};
      const row = /flex/.test(pd.display ?? "") && /^row/.test(pd["flex-direction"] ?? "row");
      const align = e.computed["align-self"] && e.computed["align-self"] !== "auto" ? e.computed["align-self"] : pd["align-items"];
      if (!row && /flex/.test(pd.display ?? "") && (align === "stretch" || align === "normal")) continue; // a stretched width
      let cap = px(max);
      if (cap === null && max.endsWith("%") && parent?.size) {
        const inner = parent.size.w - ["padding-left", "padding-right", "border-left-width", "border-right-width"].reduce((a, p) => a + (px(pd[p]) ?? 0), 0);
        cap = (parseFloat(max) / 100) * inner;
      }
      if (cap === null || !Number.isFinite(cap) || Math.abs(e.size.w - cap) > 0.5 || !wraps(e.index)) continue;
      c.add(e.path, `max-width ${max} sets the width (${+e.size.w.toFixed(2)}px) of a box whose text wraps: UI Toolkit sizes it to its longest line`);
    }
    return c.findings(rule, FIX);
  },
};
