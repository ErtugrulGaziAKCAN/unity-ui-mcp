import { cssSupport } from "../allowed-css.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-CSS-013", severity: "error",
  check(s) {
    return s.keyframes.flatMap((k) => {
      const bad = new Set<string>();
      for (const f of k.frames) for (const d of f.decls) {
        if (d.name.startsWith("--") || cssSupport.isKeyframeProperty(d.name) || d.value.trim().toLowerCase() === "initial") continue;
        bad.add(d.name);
      }
      return bad.size ? [make(rule, k.path, `@keyframes ${k.name} animates ${Array.from(bad).join(", ")}`,
        "Animate only transform, translate, rotate, scale, opacity, color, background-color and border-color in @keyframes (no layout properties).")] : [];
    });
  },
};
