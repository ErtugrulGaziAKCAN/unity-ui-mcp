import { HIDDEN_ITEM_FIX, hiddenItems } from "../repeat.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/**
 * A written-out item of a data-u-repeat that its own markup hides (the hidden attribute, an inline display: none): the
 * repeat alone shows and hides its items, from the count the host gives it, so a hidden sample is no sample data the
 * item view could show or hide (the exporter refuses it too).
 */
export const rule: Rule = {
  id: "U-MRK-013", severity: "error",
  check(s) {
    return hiddenItems(s).map((h) => make(rule, s.elements[h.index].path, h.detail, HIDDEN_ITEM_FIX[0].toUpperCase() + HIDDEN_ITEM_FIX.slice(1) + "."));
  },
};
