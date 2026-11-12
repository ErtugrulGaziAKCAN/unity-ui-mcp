import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-FONT-002", severity: "error",
  check: (s) => s.fontFaces.filter((f) => !f.fromKit).map((f) => make(rule, `@font-face "${f.family}"`,
    f.sheet === null && f.src === null ? `font face "${f.family}" added by script (FontFace)` : `@font-face "${f.family}" src: ${f.src ?? "?"}${f.sheet ? ` [${f.sheet}]` : ""}`,
    "Remove the font face: designs use only the kit's fonts (fonts/fonts.css), which kit sync writes from the Unity project's TMP fonts.")),
};
