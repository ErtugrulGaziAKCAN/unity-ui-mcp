import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";
import { TEXT_ATTRS } from "./U-MRK-007.js";

/** Ids and code-facing names: lowercase ASCII (they become C# members and USS names). */
export const ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
/**
 * Localization keys: ASCII letters in any case, digits and single '.', '_' or '-' separators. A key is the String Table
 * entry exactly as the game's tables spell it (`calendar.main.pendingOnly`): case-sensitive, never folded or respelled.
 */
export const KEY_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/;
const ID_ATTRS = ["data-u-screen", "data-u-id", "data-u-repeat", "data-u-state", "data-u-bind", "data-u-action", "data-u-arg"];
const KEY_ATTRS = ["data-l10n", ...TEXT_ATTRS.map((a) => `data-l10n-${a}`)];

/**
 * Ids, keys and code-facing names are ASCII (never case-folded: Turkish İ/ı must not reach an identifier or a key). Ids
 * and names are lowercase; keys keep any letter case.
 */
export const rule: Rule = {
  id: "U-MRK-005", severity: "error",
  check(s) {
    const out = [];
    for (const e of s.elements) {
      if (isExternal(s, e.index)) continue;
      const bad = ID_ATTRS.filter((a) => e.attrs[a] !== undefined && !ID_PATTERN.test(e.attrs[a]))
        .map((a) => `${a}="${e.attrs[a]}" does not match ${ID_PATTERN.source}`);
      const args = e.attrs["data-l10n-args"];
      if (args !== undefined && args.split(",").some((n) => !ID_PATTERN.test(n.trim()))) bad.push(`data-l10n-args="${args}" does not match ${ID_PATTERN.source}`);
      bad.push(...KEY_ATTRS.filter((a) => e.attrs[a] !== undefined && !KEY_PATTERN.test(e.attrs[a]))
        .map((a) => `${a}="${e.attrs[a]}" does not match ${KEY_PATTERN.source}`));
      if (bad.length) out.push(make(rule, e.path, bad.join("; "),
        "Use ASCII only. Ids, actions, binds and other names: lowercase letters and digits separated by single '.', '_' or '-' (e.g. gelen-kutusu-i, open-inbox). " +
        "Localization keys: letters in any case, digits and the same separators, spelled exactly as the String Table key (e.g. calendar.main.pendingOnly). " +
        "Write Turkish letters as ASCII (İ/ı → i, ş → s, ğ → g, ü → u, ö → o, ç → c)."));
    }
    return out;
  },
};
