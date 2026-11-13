import type { Rule } from "../types.js";
import { Collector, textElements } from "./util.js";

const FIX = "Include the kit base stylesheet, which sets -webkit-font-smoothing: antialiased and -moz-osx-font-smoothing: grayscale " +
  "on :root (or set them on the screen root), and do not override them on text: browsers on macOS otherwise thicken glyph stems, " +
  "which UI Toolkit does not draw, so the design would look bolder than the game.";

/**
 * Text renders with grayscale smoothing, as UI Toolkit draws it (findings: text ink). The computed value is checked on
 * every text-bearing element; when the screen root itself lacks it, its texts are reported once on the root.
 */
export const rule: Rule = {
  id: "U-CSS-038", severity: "error",
  check(s) {
    const value = (e: { computed: Record<string, string> }) => (e.computed["-webkit-font-smoothing"] ?? "").trim() || "auto";
    const bad = textElements(s).filter((e) => e.tag !== "option" && value(e) !== "antialiased");
    if (!bad.length) return [];
    const root = s.elements.find((e) => e.attrs["data-u-screen"] !== undefined);
    const rootValue = root ? value(root) : "antialiased";
    const c = new Collector();
    for (const e of bad) {
      if (root && rootValue !== "antialiased" && value(e) === rootValue) c.add(root.path, `the screen renders text with -webkit-font-smoothing: ${rootValue}`);
      else c.add(e.path, `text renders with -webkit-font-smoothing: ${value(e)}`);
    }
    return c.findings(rule, FIX);
  },
};
