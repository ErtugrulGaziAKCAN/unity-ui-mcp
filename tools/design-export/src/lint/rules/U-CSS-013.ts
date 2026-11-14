import { cssSupport } from "../allowed-css.js";
import { physicalNames } from "../snapshot.js";
import type { Rule } from "../types.js";

/** A keyframe property the player animates: listed, or a longhand of a listed shorthand (margin-top of margin). */
const animatable = (name: string) => cssSupport.isKeyframeProperty(name) || cssSupport.keyframeProperties.some((p) => p !== name && physicalNames(p).includes(name));
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-013", severity: "error",
  check(s) {
    return s.keyframes.flatMap((k) => {
      const bad = new Set<string>();
      for (const f of k.frames) for (const d of f.decls) {
        if (d.name.startsWith("--") || animatable(d.name) || d.value.trim().toLowerCase() === "initial") continue;
        bad.add(d.name);
      }
      return bad.size ? [make(rule, k.path, `@keyframes ${k.name} animates ${Array.from(bad).join(", ")}`,
        "Animate only what the animation player animates in @keyframes: transform, translate, rotate, scale, opacity, colours and border radii. For a change of size or position (width, height, margins, paddings, insets, border widths, flex sizes, font-size, line-height) animate translate or scale instead: a layout property would lay the screen out in every frame.")] : [];
    });
  },
};
