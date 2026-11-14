import { layoutOf } from "../layout.js";
import { motionOf } from "../motion.js";
import type { Rule } from "../types.js";
import { Collector } from "./util.js";

const FIX = "Animate a property of one element either with @keyframes or with a transition, not both: move the transition " +
  "(or the animation) to another property or to a wrapper element. CSS runs the transition over the animation while both " +
  "run; the animation player plays one value per property.";

/**
 * Keyframes and a transition of the same property on one element: a keyframe animation (any layer) animates a property
 * that a layer change also transitions (what the IR records as a transition).
 */
export const rule: Rule = {
  id: "U-CSS-043", severity: "error",
  check(s) {
    const c = new Collector();
    const L = layoutOf(s);
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      const m = motionOf(L, e.index);
      if (!m) continue;
      const both = Array.from(m.keyframed.keys()).filter((p) => m.transitioned.has(p)).sort();
      for (const p of both) {
        c.add(e.path, `${p} is animated by @keyframes ${Array.from(m.keyframed.get(p)!).sort().join(", ")} and transitioned (${Array.from(m.transitioned.get(p)!).sort().join(", ")})`);
      }
    }
    return c.findings(rule, FIX);
  },
};
