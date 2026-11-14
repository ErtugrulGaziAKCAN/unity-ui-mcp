import type { Rule } from "../types.js";
import { isExternal, make } from "./util.js";
import { TEXT_ATTRS } from "./U-MRK-007.js";

/** Ids and code-facing names: lowercase ASCII (they become C# members and USS names). */
export const ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
/**
 * Localization keys: ASCII letters in any case, digits and single '.', '_' or '-' separators. A key is the String Table
 * entry exactly as the game's tables spell it (`inbox.main.unreadOnly`): case-sensitive, never folded or respelled.
 */
export const KEY_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/;
const ID_ATTRS = ["data-u-screen", "data-u-id", "data-u-repeat", "data-u-state", "data-u-bind", "data-u-action", "data-u-arg"];

/**
 * The C# member part a code-facing name gives, as the Unity view generator makes it (Naming.Pascal): the parts between
 * '.', '-' and '_', each with its first letter capitalised; null when that is empty or starts with a digit, which the
 * generator rejects. Every name of ID_ATTRS (and of data-l10n-args) becomes such a member: the screen view class, an
 * element property, a repeat's item view and setter, a State member, a value setter (Set<Name>) or an action event.
 */
export function memberPart(name: string): string | null {
  const out = name.split(/[._-]/).filter((p) => p.length > 0).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return out.length === 0 || /^[0-9]/.test(out) ? null : out;
}
const MEMBER_FIX = "Names that become generated C# members start with a letter (a-z): name an argument after what it holds, e.g. " +
  "data-u-arg=\"count\" with {count} in data-en (a profile with indexed arguments writes {0}, {1} itself, in the order the text has them).";
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
      // the generator's own rule (Naming.Pascal): a name that matches the pattern can still give no C# member
      const noMember = ID_ATTRS.filter((a) => e.attrs[a] !== undefined && ID_PATTERN.test(e.attrs[a]) && memberPart(e.attrs[a]) === null)
        .map((a) => `${a}="${e.attrs[a]}" gives no C# member name (it starts with a digit)`);
      const args = e.attrs["data-l10n-args"];
      if (args !== undefined && args.split(",").some((n) => !ID_PATTERN.test(n.trim()))) bad.push(`data-l10n-args="${args}" does not match ${ID_PATTERN.source}`);
      else if (args !== undefined && args.split(",").some((n) => memberPart(n.trim()) === null)) noMember.push(`data-l10n-args="${args}" names an argument that gives no C# member name (it starts with a digit)`);
      if (noMember.length) out.push(make(rule, e.path, noMember.join("; "), MEMBER_FIX));
      bad.push(...KEY_ATTRS.filter((a) => e.attrs[a] !== undefined && !KEY_PATTERN.test(e.attrs[a]))
        .map((a) => `${a}="${e.attrs[a]}" does not match ${KEY_PATTERN.source}`));
      if (bad.length) out.push(make(rule, e.path, bad.join("; "),
        "Use ASCII only. Ids, actions, binds and other names: lowercase letters and digits separated by single '.', '_' or '-' (e.g. gelen-kutusu-i, open-inbox). " +
        "Localization keys: letters in any case, digits and the same separators, spelled exactly as the String Table key (e.g. inbox.main.unreadOnly). " +
        "Write Turkish letters as ASCII (İ/ı → i, ş → s, ğ → g, ü → u, ö → o, ç → c)."));
    }
    return out;
  },
};
