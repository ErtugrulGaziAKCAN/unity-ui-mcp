import { shownDisplay } from "./repeat.js";
import type { DomSnapshot, SnapElement } from "./snapshot.js";

/**
 * Text runs, shared by lint (U-MRK-008, U-MRK-009, U-CSS-016) and the IR extraction.
 * - An inline element that carries a key, bind, id or action (a "keyed run") is its own IR text node. A paragraph
 *   whose only content is one keyed run becomes a container with that text child; several keyed runs on one line
 *   with nothing between them become a row; anything else would not render the same and is rejected.
 * - Smart String arguments are marked inside localized text: `<span data-u-arg="name">Ali</span>`, with `{name}` in
 *   data-en. The IR text holds `{name}`; "Ali" is the sample value.
 */

export const RICH_TAGS = new Set(["b", "strong", "i", "em", "span", "br"]);
export const KEY_ATTRS = ["data-l10n", "data-u-bind", "data-u-id", "data-u-action"];
const NO_TEXT = new Set(["script", "style", "template", "noscript", "title"]);

export const isKeyed = (e: SnapElement) => KEY_ATTRS.some((a) => e.attrs[a] !== undefined);
export const isArg = (e: SnapElement) => e.attrs["data-u-arg"] !== undefined;

const memo = <T>(fn: (s: DomSnapshot) => T) => {
  const cache = new WeakMap<DomSnapshot, T>();
  return (s: DomSnapshot): T => { if (!cache.has(s)) cache.set(s, fn(s)); return cache.get(s)!; };
};

/**
 * An inline child of a text: b, strong, i, em or span in text flow (or br), whose content is text or such children
 * (judged as an item that shows it lays it out, where a repeat item's markup hides it or its parent as sample data).
 */
export function isRichInline(s: DomSnapshot, c: SnapElement): boolean {
  if (c.ns !== "html" || !RICH_TAGS.has(c.tag)) return false;
  if (c.tag === "br") return true;
  if (!shownDisplay(s, c.index).startsWith("inline") || c.attrs["data-u-repeat"] !== undefined) return false;
  return c.children.every((k) => isRichInline(s, s.elements[k]));
}

/** Inside a data-u-external region or script/style content: not compiled, not judged. */
const outside = memo((s): boolean[] => {
  const out = s.elements.map(() => false);
  for (const e of s.elements) {
    const p = e.parent >= 0 ? s.elements[e.parent] : null;
    out[e.index] = NO_TEXT.has(e.tag) || (!!p && (out[p.index] || p.attrs["data-u-external"] !== undefined));
  }
  return out;
});

export const hasText = (s: DomSnapshot, e: SnapElement): boolean => e.texts.length > 0 || e.children.some((k) => hasText(s, s.elements[k]));

/** Content is text with optional rich inline children (at least one character somewhere). */
export function isTextElement(s: DomSnapshot, e: SnapElement): boolean {
  if (e.ns !== "html" || NO_TEXT.has(e.tag)) return false;
  return e.children.every((k) => isRichInline(s, s.elements[k])) && hasText(s, e);
}

export type RunPlan =
  | { kind: "single"; child: number }
  | { kind: "row"; children: number[]; justify: "flex-start" | "center" | "flex-end" }
  | { kind: "error"; detail: string; fix: string };

const SPLIT_FIX = "Give each keyed text its own block element (or put several in a flex row with gap); mark a variable inside one localized text with <span data-u-arg=\"name\"> and {name} in data-en.";
const keyedBelow = (s: DomSnapshot, e: SnapElement): boolean => e.children.some((k) => isKeyed(s.elements[k]) || keyedBelow(s, s.elements[k]));
const JUSTIFY: Record<string, "flex-start" | "center" | "flex-end"> = {
  start: "flex-start", left: "flex-start", "-webkit-left": "flex-start", center: "center", "-webkit-center": "center",
  right: "flex-end", end: "flex-end", "-webkit-right": "flex-end",
};

/** How a text element with keyed inline children compiles; null for a plain text (no keyed inline child). */
export function runPlan(s: DomSnapshot, i: number): RunPlan | null {
  const e = s.elements[i];
  if (!isTextElement(s, e)) return null;
  const kids = e.children.map((k) => s.elements[k]);
  const keyed = kids.filter((c) => c.tag !== "br" && isKeyed(c));
  const deep = kids.filter((c) => !isKeyed(c) && keyedBelow(s, c));
  if (!keyed.length && !deep.length) return null;
  const paths = (l: SnapElement[]) => l.map((c) => c.path).join(", ");
  const err = (detail: string, fix = SPLIT_FIX): RunPlan => ({ kind: "error", detail, fix });
  if (deep.length) return err(`a keyed element sits inside the unkeyed inline ${paths(deep)}`);
  if (e.texts.length) return err(`text "${e.texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 40)}" sits in one line with the keyed inline ${paths(keyed)}`);
  if (e.attrs["data-l10n"] !== undefined || e.attrs["data-u-bind"] !== undefined) {
    return err(`${e.attrs["data-l10n"] !== undefined ? "data-l10n" : "data-u-bind"} on ${e.path} has no text of its own (its text is in ${paths(keyed)})`, "Put the key or bind only on the element that holds the text.");
  }
  const others = kids.filter((c) => !isKeyed(c));
  if (others.length) return err(`${paths(others)} sit in one line with the keyed inline ${paths(keyed)}`);
  const differs = keyed.filter((c) => c.computed["font-size"] !== e.computed["font-size"] || c.computed["line-height"] !== e.computed["line-height"]);
  if (differs.length) {
    return err(`${paths(differs)} change the font size or line height inside the line of ${e.path}`,
      "Give the keyed element display: block (it then sets its own line), or keep its font size and line height equal to its parent's.");
  }
  if (keyed.length === 1) return { kind: "single", child: keyed[0].index };
  const boxes = keyed.map((c) => c.box);
  if (!e.rendered || boxes.some((b) => !b)) return err(`several keyed inline texts (${paths(keyed)}) in a line that is hidden by default cannot be checked`);
  const b = boxes as { x: number; y: number; w: number; h: number }[];
  const oneLine = b.every((x) => Math.abs(x.y - b[0].y) < 0.5 && Math.abs(x.h - b[0].h) < 0.5);
  const touching = b.every((x, k) => k === 0 || Math.abs(x.x - (b[k - 1].x + b[k - 1].w)) < 0.5);
  if (!oneLine || !touching) {
    return err(`several keyed inline texts (${paths(keyed)}) share one line of text${oneLine ? " with space between them" : " that wraps"}; a row of separate texts would not render the same`);
  }
  const justify = JUSTIFY[e.computed["text-align"] ?? "start"];
  if (!justify) return err(`text-align: ${e.computed["text-align"]} on ${e.path} spreads its keyed inline texts`);
  return { kind: "row", children: keyed.map((c) => c.index), justify };
}

/** Every text element's run plan (only those with keyed inline children). */
export const runPlans = memo((s): Map<number, RunPlan> => {
  const out = new Map<number, RunPlan>();
  for (const e of s.elements) { if (outside(s)[e.index]) continue; const p = runPlan(s, e.index); if (p) out.set(e.index, p); }
  return out;
});

/** Keyed inline elements that compile as their own text nodes (their text style is a full kit style). */
export const promotedRuns = memo((s): Set<number> => {
  const out = new Set<number>();
  for (const p of runPlans(s).values()) {
    if (p.kind === "single") out.add(p.child);
    else if (p.kind === "row") p.children.forEach((c) => out.add(c));
  }
  return out;
});

/** data-u-arg spans of a localized text, in document order (not entering keyed runs, which are texts of their own). */
export function argSpans(s: DomSnapshot, i: number): number[] {
  const out: number[] = [];
  const walk = (k: number) => {
    for (const c of s.elements[k].children) {
      const x = s.elements[c];
      if (isKeyed(x) && !isArg(x)) continue;
      if (isArg(x)) out.push(c); else walk(c);
    }
  };
  walk(i);
  return out;
}

const PLACEHOLDER = /\{([^{}]*)\}/g;
export const placeholders = (en: string): string[] => Array.from(en.matchAll(PLACEHOLDER), (m) => m[1].trim());

/** Smart String argument problems per element path. */
export const argProblems = memo((s): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  const add = (e: SnapElement, msg: string) => out.set(e.path, [...(out.get(e.path) ?? []), msg]);
  for (const e of s.elements) {
    if (outside(s)[e.index]) continue;
    if (isArg(e)) {
      if (!isRichInline(s, e) || e.tag === "br") add(e, `data-u-arg="${e.attrs["data-u-arg"]}" is on <${e.tag}> (display: ${e.computed.display}), not an inline span inside the text`);
      const keys = KEY_ATTRS.filter((a) => e.attrs[a] !== undefined);
      if (keys.length) add(e, `data-u-arg="${e.attrs["data-u-arg"]}" also has ${keys.join(", ")}: an argument is a value inside the localized text, not an element of its own`);
      let p = e.parent;
      while (p >= 0 && s.elements[p].attrs["data-l10n"] === undefined && isRichInline(s, s.elements[p]) && !isKeyed(s.elements[p])) p = s.elements[p].parent;
      if (p < 0 || s.elements[p].attrs["data-l10n"] === undefined) add(e, `data-u-arg="${e.attrs["data-u-arg"]}" is not inside a localized text (an element with data-l10n)`);
      if (s.elements[e.index].children.some((k) => isArg(s.elements[k]) || isKeyed(s.elements[k]))) add(e, `data-u-arg="${e.attrs["data-u-arg"]}" contains another argument or keyed element`);
    }
    const key = e.attrs["data-l10n"];
    if (key === undefined) continue;
    const args = argSpans(s, e.index).map((k) => s.elements[k].attrs["data-u-arg"]);
    // without data-en the visible text is the English entry (an English reference locale; else U-MRK-004 asks for it)
    const hasEn = (e.attrs["data-en"] ?? "").trim() !== "";
    const names = placeholders(e.attrs["data-en"] ?? "");
    const dup = (l: string[]) => Array.from(new Set(l.filter((n, k) => l.indexOf(n) !== k)));
    if (dup(args).length) add(e, `data-u-arg ${dup(args).map((n) => `"${n}"`).join(", ")} appears more than once`);
    if (dup(names).length) add(e, `data-en uses {${dup(names).join("}, {")}} more than once`);
    const missingSpan = names.filter((n) => !args.includes(n)), missingName = args.filter((n) => !names.includes(n));
    if (missingSpan.length) add(e, `data-en "${e.attrs["data-en"]}" has {${missingSpan.join("}, {")}} without a <span data-u-arg> in the text`);
    if (missingName.length && hasEn) add(e, `<span data-u-arg="${missingName.join("\">, <span data-u-arg=\"")}"> has no {${missingName.join("}, {")}} in data-en`);
    const declared = e.attrs["data-l10n-args"];
    if (declared !== undefined) {
      const d = declared.split(",").map((x) => x.trim()).filter(Boolean);
      if (d.slice().sort().join(",") !== Array.from(new Set(args)).sort().join(",")) add(e, `data-l10n-args="${declared}" does not list the data-u-arg names (${args.join(", ") || "none"})`);
    }
  }
  return out;
});
