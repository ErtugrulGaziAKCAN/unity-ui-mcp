import type { DomSnapshot } from "../snapshot.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign, textElements } from "./util.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Punctuation after which UI Toolkit's advanced text generator (Enable Advanced Text) breaks a word too long for its line,
 * measured in Unity 6000.3 (docs/findings/line-breaks.md): quotation marks and guillemets other than the apostrophes, and
 * other punctuation. The standard generator breaks such a word after the last character that fits. Apostrophes (' ’ ‘ ʼ)
 * and the full stop never take that break in either generator.
 */
export const ADVANCED_BREAKS_AFTER = "«»“”„‚‹›\"()!%,/:`";

/**
 * A word wider than its wrapping box: the browser has no break opportunity inside it (UAX #14, overflow-wrap: normal),
 * keeps it on its line and lets it overflow; UI Toolkit breaks every word that does not fit its line inside the word
 * (docs/findings/line-breaks.md), so the line count and breaks differ from the design and verify fails. Typical: a word
 * with an apostrophe or a quotation mark between letters ("AUJOURD’HUI") in a narrow cell. Only the design's own text
 * is judged; a translation with a longer word breaks the same way in Unity.
 */
export const rule: Rule = {
  id: "W-TEXT-001", severity: "warning",
  check(s: DomSnapshot) {
    const out = [];
    for (const e of textElements(s)) {
      const o = e.textOverflow;
      if (!o || nonDesign(s)[e.index] || isExternal(s, e.index)) continue;
      const after = Array.from(new Set(Array.from(o.word.slice(0, -1)).filter((c) => ADVANCED_BREAKS_AFTER.includes(c))));
      const where = after.length
        ? `UI Toolkit breaks it inside the word: the standard text generator after the last character that fits, the advanced one (Enable Advanced Text) after ${after.map((c) => `“${c}”`).join(", ")}`
        : "UI Toolkit breaks it inside the word, after the last character that fits";
      out.push(make(rule, e.path,
        `the word "${o.word}" is ${r2(o.wordWidth)} px wide in a ${r2(o.boxWidth)} px wide text box that wraps: the browser keeps it on one line and lets it ` +
        `overflow by ${r2(Math.max(o.left, o.right))} px; ${where}, so the lines differ from the design`,
        `Give the box room for its longest word (also in the translations), or make the text white-space: nowrap (with overflow: hidden and ` +
        `text-overflow: ellipsis when it may be cut), or use a shorter word. UI Toolkit never lets a word overflow its line.`));
    }
    return out;
  },
};
