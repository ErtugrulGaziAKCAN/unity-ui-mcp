import type { ContractKind, ScreenContract } from "../contract.js";
import { englishEntry } from "../extract/text.js";
import { referenceIsEnglish, type KitConfig } from "../kit.js";
import { clip } from "./css-values.js";
import { repeatOf } from "./repeat.js";
import { TEXT_ATTRS } from "./rules/U-MRK-007.js";
import { isExternal, nonDesign } from "./rules/util.js";
import type { DomSnapshot } from "./snapshot.js";
import type { LintContext } from "./types.js";

/**
 * What the design has, in the screen contract's terms (spec 2026-11-16-screen-contract §5): one item per kind, name
 * and scope, gathered over every written-out sample row, so the contract rules (U-CON-002 … U-CON-006) compare it with
 * the contract's items.
 */
export interface DesignItem {
  kind: ContractKind;
  /** Bind/arg/action/state/repeat name, or the text key. */
  name: string;
  /** Scope, as ContractItem.repeat: the enclosing repeat's name (a repeat: its parent repeat); null is the screen. Always null for states and texts. */
  repeat: string | null;
  /** Element paths of its occurrences, document order, for findings. */
  paths: string[];
  /** Values: the normalized text every rendered occurrence shows (all sample rows); empty for other kinds. */
  samples: string[];
  /** Texts: the English as U-MRK-014 reads it (data-en, or the visible text with the reference locale en), normalized. */
  en?: string;
  /** Texts with a reference locale other than en: the visible text (variables as `{name}`) or attribute value, normalized. */
  ref?: string;
}

/** Contract text comparison: whitespace runs collapsed to one space, trimmed, NFC. */
export const normalizeText = (t: string): string => t.normalize("NFC").replace(/\s+/g, " ").trim();

/** States and texts are screen-wide: their scope is always the screen. */
const scopeOf = (kind: ContractKind, repeat: string | null) => (kind === "state" || kind === "text" ? null : repeat);

/** Kind, name and scope as one key: what matches a design item with a contract item or a removed entry. */
export const itemKey = (x: { kind: ContractKind; name: string; repeat: string | null }): string =>
  `${x.kind}\u0000${x.name}\u0000${scopeOf(x.kind, x.repeat) ?? ""}`;

/** `value "title" in repeat "player"`: an item as findings name it. */
export const describeItem = (x: { kind: ContractKind; name: string; repeat: string | null }): string => {
  const scope = scopeOf(x.kind, x.repeat);
  return `${x.kind} "${x.name}"${scope !== null ? ` in repeat "${scope}"` : ""}`;
};

/** The design's screen id: the data-u-screen of its one screen root; undefined when there is not exactly one (U-MRK-001). */
export function screenId(s: DomSnapshot): string | undefined {
  const roots = s.elements.filter((e) => e.attrs["data-u-screen"] !== undefined);
  return roots.length === 1 ? roots[0].attrs["data-u-screen"] : undefined;
}

/** The contract U-CON-002 … U-CON-006 compare with: a valid one for the design's own screen, else null (U-CON-001 reports why). */
export function checkedContract(s: DomSnapshot, ctx: LintContext): ScreenContract | null {
  const c = ctx.contract;
  if (c === null || c.state !== "valid") return null;
  return c.contract.screen === screenId(s) ? c.contract : null;
}

/** A contract string as a finding quotes it. */
export const quote = (t: string): string => `"${clip(t, 60)}"`;

const blankToUndefined = (t: string | undefined): string | undefined => (t === undefined || t.trim() === "" ? undefined : t);

const cache = new WeakMap<DomSnapshot, Map<boolean, DesignItem[]>>();

/**
 * Every value (data-u-bind, data-u-arg), action (data-u-action), state (data-u-state), repeat (data-u-repeat) and text
 * key (data-l10n, data-l10n-<attr>) of the design, outside external regions and non-design elements. The scope is the
 * repeat whose written-out item holds the element (for a repeat, its container's); the same kind, name and scope in
 * several sample rows is one item. Elements hidden in a sample row are items too; only rendered values give samples.
 */
export function designInventory(s: DomSnapshot, kit: KitConfig): DesignItem[] {
  const english = referenceIsEnglish(kit);
  const hit = cache.get(s)?.get(english);
  if (hit) return hit;
  const items = new Map<string, DesignItem>();
  const add = (kind: ContractKind, name: string, repeat: string | null, i: number): DesignItem => {
    const key = itemKey({ kind, name, repeat });
    let it = items.get(key);
    if (!it) { it = { kind, name, repeat: scopeOf(kind, repeat), paths: [], samples: [] }; items.set(key, it); }
    const path = s.elements[i].path;
    if (!it.paths.includes(path)) it.paths.push(path);
    return it;
  };
  // a text key keeps the English and reference text of its first occurrence that has them
  const text = (key: string, i: number, en: string | undefined, ref: string | undefined) => {
    const it = add("text", key, null, i);
    if (it.en === undefined && en !== undefined) it.en = normalizeText(en);
    if (it.ref === undefined && ref !== undefined) it.ref = normalizeText(ref);
  };
  for (const e of s.elements) {
    if (isExternal(s, e.index) || nonDesign(s)[e.index]) continue;
    const a = e.attrs;
    const named = (attr: string) => (a[attr] !== undefined && a[attr] !== "" ? a[attr] : undefined);
    const scope = () => repeatOf(s, e.index) ?? null;
    for (const attr of ["data-u-bind", "data-u-arg"]) {
      const name = named(attr);
      if (name === undefined) continue;
      const it = add("value", name, scope(), e.index);
      if (e.boundText != null) it.samples.push(normalizeText(e.boundText));
    }
    const action = named("data-u-action");
    if (action !== undefined) add("action", action, scope(), e.index);
    const state = named("data-u-state");
    if (state !== undefined) add("state", state, null, e.index);
    const repeat = named("data-u-repeat");
    if (repeat !== undefined) add("repeat", repeat, e.parent >= 0 ? repeatOf(s, e.parent) ?? null : null, e.index);
    const key = named("data-l10n");
    if (key !== undefined) {
      // the visible text as the import reads it (variables as {name}), U-MRK-014's reading
      const visible = e.enToks !== undefined
        ? englishEntry(e.enToks, (e.computed["white-space-collapse"] ?? "collapse") !== "collapse", e.enRendered)
        : undefined;
      const dataEn = blankToUndefined(a["data-en"]);
      if (english) text(key, e.index, visible ?? dataEn, undefined);
      else text(key, e.index, dataEn, visible);
    }
    for (const t of TEXT_ATTRS) {
      const attrKey = named(`data-l10n-${t}`);
      if (attrKey === undefined) continue;
      const value = blankToUndefined(a[t]);
      const dataEn = blankToUndefined(a[`data-en-${t}`]);
      if (english) text(attrKey, e.index, value ?? dataEn, undefined);
      else text(attrKey, e.index, dataEn, value);
    }
  }
  const out = Array.from(items.values());
  const per = cache.get(s) ?? new Map<boolean, DesignItem[]>();
  per.set(english, out);
  cache.set(s, per);
  return out;
}
