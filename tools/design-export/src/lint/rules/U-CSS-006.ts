import { stripStringsAndUrls } from "../css-values.js";
import type { Rule } from "../types.js";
import { declRule, declText } from "./util.js";

export const VIEWPORT_UNIT = /(^|[^\w.#-])[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[sld]?v(?:w|h|i|b|min|max)(?![\w-])/i;

export const rule: Rule = {
  id: "U-CSS-006", severity: "error",
  check: (s) => declRule(s, rule, "Use px or % instead of viewport units: the screen is laid out on the 2560×1440 reference and scaled by the panel.",
    (d, v) => (VIEWPORT_UNIT.test(stripStringsAndUrls(v)) ? declText(d, v) : null), { pseudo: true, keyframes: true }),
};
