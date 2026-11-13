import type { Rule } from "../types.js";
import { make } from "./util.js";

const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The screen root is the artboard: exactly kit.reference in CSS px at the page origin (spec 5.5). */
export const rule: Rule = {
  id: "U-MRK-006", severity: "error",
  check(s, kit) {
    const [w, h] = kit.reference;
    return s.elements.filter((e) => e.attrs["data-u-screen"] !== undefined).flatMap((e) => {
      const b = e.box;
      if (b && near(b.x, 0) && near(b.y, 0) && near(b.w, w) && near(b.h, h)) return [];
      return [make(rule, e.path, b ? `screen root is ${r2(b.w)}×${r2(b.h)} at (${r2(b.x)}, ${r2(b.y)}); it must be ${w}×${h} at (0, 0)` : "screen root is not rendered",
        `Make the data-u-screen element the ${w}×${h} artboard at the page origin: width: ${w}px; height: ${h}px; no margin or transform, and body { margin: 0 }.`)];
    });
  },
};
