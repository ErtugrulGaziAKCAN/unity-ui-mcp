import { layoutOf } from "../layout.js";
import { isLayoutProperty, motionOf, notPlayed } from "../motion.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

const FIX = "Transition only what the animation player animates: transforms (translate, rotate, scale), opacity and colours " +
  "(and border radii). For a change of size or position (width, height, margins, paddings, insets, border widths, flex sizes, " +
  "font-size, line-height) transition translate or scale instead; otherwise remove the property from transition-property " +
  "(with transition-property: all, name the properties you mean instead). A layout property would lay the screen out in " +
  "every frame, and the other properties change at once in Unity while CSS animates them.";

/**
 * A transition CSS plays and the animation player does not: transition-property names (or, with `all`, a layer changes) a
 * property CSS interpolates that the player cannot animate, with a positive combined duration. Box-shadow and
 * background-image transitions are U-CSS-014's (baked per layer).
 */
export const rule: Rule = {
  id: "U-CSS-042", severity: "error",
  check(s) {
    const c = new Collector();
    const L = layoutOf(s);
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      const m = motionOf(L, e.index);
      if (!m) continue;
      const bad = new Map<string, Set<string>>();
      for (const src of [m.named, m.transitioned]) {
        for (const [p, where] of src) {
          if (!notPlayed(p)) continue;
          if (!bad.has(p)) bad.set(p, new Set());
          where.forEach((w) => bad.get(p)!.add(w === "show" ? "base" : w));
        }
      }
      if (!bad.size) continue;
      const props = Array.from(bad.keys()).sort();
      const layout = props.filter(isLayoutProperty);
      c.add(e.path, `a transition of ${props.join(", ")} (${Array.from(new Set(props.flatMap((p) => Array.from(bad.get(p)!)))).sort().join(", ")})` +
        (layout.length ? `; ${layout.join(", ")} lay${layout.length === 1 ? "s" : ""} the screen out` : ""));
    }
    return c.findings(rule, FIX);
  },
};
