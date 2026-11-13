import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";
import { TEXT_ATTRS } from "./U-MRK-007.js";

export const ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const ATTRS = ["data-u-screen", "data-u-id", "data-l10n", "data-u-repeat", "data-u-state", "data-u-bind", "data-u-action",
  ...TEXT_ATTRS.map((a) => `data-l10n-${a}`)];

/** Ids, keys and code-facing names are lowercase ASCII (never case-folded: Turkish İ/ı must not reach an identifier). */
export const rule: Rule = {
  id: "U-MRK-005", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (isExternal(s, e.index)) continue;
      const bad = ATTRS.filter((a) => e.attrs[a] !== undefined && !ID_PATTERN.test(e.attrs[a])).map((a) => `${a}="${e.attrs[a]}"`);
      const args = e.attrs["data-l10n-args"];
      if (args !== undefined && args.split(",").some((n) => !ID_PATTERN.test(n.trim()))) bad.push(`data-l10n-args="${args}"`);
      if (bad.length) out.push(make(rule, e.path, bad.join(", ") + " does not match ^[a-z0-9]+([._-][a-z0-9]+)*$",
        "Use lowercase ASCII letters and digits separated by single '.', '_' or '-' (e.g. gelen-kutusu-i, open-inbox); write Turkish letters as ASCII (İ/ı → i, ş → s, ğ → g, ü → u, ö → o, ç → c)."));
    }
    return out;
  },
};
