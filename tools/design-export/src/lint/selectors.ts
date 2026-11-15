import { closeOf, splitTopLevel } from "./css-values.js";

/** One simple selector of a compound (`div`, `#a`, `.b`, `[c]`, `:hover`, `::before`). */
export interface Simple {
  kind: "type" | "universal" | "id" | "class" | "attr" | "pseudo-class" | "pseudo-element" | "nesting";
  /** Lowercased for pseudo names; as written otherwise. */
  name: string;
  /** Argument text of a functional pseudo, without the parentheses. */
  arg?: string;
  raw: string;
}

export interface Compound { combinator: "" | " " | ">" | "+" | "~"; simples: Simple[] }
export interface ParsedSelector { text: string; compounds: Compound[] }

/** Pseudo-classes that depend on interaction or form state; stripped when deciding which elements a rule can reach. */
export const DYNAMIC_PSEUDO_CLASSES = new Set([
  "hover", "active", "focus", "focus-visible", "focus-within", "visited", "link", "any-link", "target", "target-within",
  "checked", "disabled", "enabled", "indeterminate", "default", "required", "optional", "valid", "invalid", "user-valid",
  "user-invalid", "in-range", "out-of-range", "read-only", "read-write", "placeholder-shown", "autofill", "-webkit-autofill",
  "popover-open", "open", "closed", "modal", "fullscreen", "playing", "paused", "local-link", "current", "past", "future",
]);

/** Position- or content-dependent pseudo-classes (U-CSS-003). */
export const STRUCTURAL_PSEUDO_CLASSES = new Set([
  "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "first-child", "last-child", "only-child",
  "first-of-type", "last-of-type", "only-of-type", "empty",
]);

const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
const SELECTOR_ARG = new Set(["is", "where", "not", "has", "matches", "-webkit-any", "host", "host-context"]);
/** Classes the view toggles at runtime (spec: `is-*` custom states; `state-*` screen states). */
const RUNTIME_CLASS = /^(?:is|state)-/;

function readIdent(t: string, i: number): number {
  let j = i;
  while (j < t.length) {
    const c = t[j];
    if (c === "\\") { j += 2; continue; }
    if (/[\w-]/.test(c) || c.charCodeAt(0) > 0x7f) { j++; continue; }
    break;
  }
  return j;
}

/** Parses one complex selector (no top-level commas). */
export function parseSelector(text: string): ParsedSelector {
  const t = text.trim();
  const compounds: Compound[] = [];
  let cur: Compound = { combinator: "", simples: [] };
  let pending: Compound["combinator"] | null = null;
  const flush = () => { if (cur.simples.length) compounds.push(cur); };
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (/\s/.test(c)) { if (cur.simples.length && pending === null) pending = " "; i++; continue; }
    if (c === ">" || c === "+" || c === "~") { pending = c; i++; continue; }
    if (pending !== null) { flush(); cur = { combinator: pending, simples: [] }; pending = null; }
    if (c === "*") { cur.simples.push({ kind: "universal", name: "*", raw: "*" }); i++; continue; }
    if (c === "&") { cur.simples.push({ kind: "nesting", name: "&", raw: "&" }); i++; continue; }
    if (c === "#" || c === ".") {
      const e = readIdent(t, i + 1);
      cur.simples.push({ kind: c === "#" ? "id" : "class", name: t.slice(i + 1, e), raw: t.slice(i, e) });
      i = e; continue;
    }
    if (c === "[") {
      const e = closeOf(t, i);
      cur.simples.push({ kind: "attr", name: t.slice(i + 1, e - 1).split(/[~|^$*]?=/)[0].trim(), raw: t.slice(i, e) });
      i = e; continue;
    }
    if (c === ":") {
      const isElement = t[i + 1] === ":";
      const s = i + (isElement ? 2 : 1);
      const e = readIdent(t, s);
      const name = t.slice(s, e).toLowerCase();
      let end = e;
      let arg: string | undefined;
      if (t[e] === "(") { end = closeOf(t, e); arg = t.slice(e + 1, end - 1); }
      const kind = isElement || LEGACY_PSEUDO_ELEMENTS.has(name) ? "pseudo-element" : "pseudo-class";
      cur.simples.push({ kind, name, arg, raw: t.slice(i, end) });
      i = end; continue;
    }
    const e = readIdent(t, i);
    if (e === i) { i++; continue; } // unknown character: skip rather than loop
    let end = e;
    if (t[e] === "|" && t[e + 1] !== "=") end = readIdent(t, e + 1); // ns|type
    cur.simples.push({ kind: "type", name: t.slice(i, end), raw: t.slice(i, end) });
    i = end;
  }
  flush();
  return { text: t, compounds };
}

export function parseSelectorList(text: string): ParsedSelector[] {
  return splitTopLevel(text, ",").filter(Boolean).map(parseSelector);
}

const argSelectors = (s: Simple): ParsedSelector[] => {
  if (!s.arg) return [];
  if (SELECTOR_ARG.has(s.name)) return parseSelectorList(s.arg);
  if ((s.name === "nth-child" || s.name === "nth-last-child") && / of /i.test(s.arg)) return parseSelectorList(s.arg.split(/ of /i)[1]);
  return [];
};

/** Every pseudo-class name in the selector, including inside :is()/:not()/:has()/:where() arguments. */
export function pseudoClasses(sel: ParsedSelector): string[] {
  const out: string[] = [];
  for (const c of sel.compounds) for (const s of c.simples) {
    if (s.kind === "pseudo-class") out.push(s.name);
    for (const a of argSelectors(s)) out.push(...pseudoClasses(a));
  }
  return out;
}

/** The pseudo-element the selector styles (`before`, `placeholder`, …) or null. */
export function pseudoElement(sel: ParsedSelector): string | null {
  const last = sel.compounds[sel.compounds.length - 1];
  const pe = last?.simples.find((s) => s.kind === "pseudo-element");
  return pe ? pe.name : null;
}

export function structural(sel: ParsedSelector): string[] {
  return Array.from(new Set(pseudoClasses(sel).filter((p) => STRUCTURAL_PSEUDO_CLASSES.has(p))));
}

type Spec = [number, number, number];
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cmp = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const maxSpec = (list: ParsedSelector[]): Spec => list.map(specificity).reduce((m, s) => (cmp(s, m) > 0 ? s : m), [0, 0, 0] as Spec);

/** Selectors Level 4 specificity. */
export function specificity(sel: ParsedSelector): Spec {
  let sp: Spec = [0, 0, 0];
  for (const c of sel.compounds) for (const s of c.simples) {
    if (s.kind === "id") sp = add(sp, [1, 0, 0]);
    else if (s.kind === "class" || s.kind === "attr") sp = add(sp, [0, 1, 0]);
    else if (s.kind === "type" || s.kind === "pseudo-element") sp = add(sp, [0, 0, 1]);
    else if (s.kind === "pseudo-class") {
      if (s.name === "where") continue;
      if (s.name === "is" || s.name === "not" || s.name === "has" || s.name === "matches" || s.name === "-webkit-any") sp = add(sp, maxSpec(argSelectors(s)));
      else if (s.name === "nth-child" || s.name === "nth-last-child") sp = add(add(sp, [0, 1, 0]), maxSpec(argSelectors(s)));
      else sp = add(sp, [0, 1, 0]);
    }
  }
  return sp;
}

/** Whether a selector depends on an interaction or screen state (a dynamic pseudo-class, an `is-*`/`state-*` class). */
export const touchesRuntime = (sel: ParsedSelector): boolean =>
  sel.compounds.some((c) => c.simples.some((s) =>
    (s.kind === "pseudo-class" && DYNAMIC_PSEUDO_CLASSES.has(s.name)) ||
    (s.kind === "class" && RUNTIME_CLASS.test(s.name)) ||
    argSelectors(s).some(touchesRuntime)));

/**
 * A selector for querySelectorAll that matches every element the rule can reach in some interaction or screen state:
 * interaction pseudo-classes, `is-*`/`state-*` classes and pseudo-elements are removed (an emptied compound becomes
 * `*`), `:not()` around any of them is dropped. Over-approximates; never misses an element.
 */
export function reachSelector(sel: ParsedSelector): string {
  const parts: string[] = [];
  for (const c of sel.compounds) {
    const kept: string[] = [];
    for (const s of c.simples) {
      if (s.kind === "pseudo-element") continue;
      if (s.kind === "pseudo-class" && DYNAMIC_PSEUDO_CLASSES.has(s.name)) continue;
      if (s.kind === "class" && RUNTIME_CLASS.test(s.name)) continue;
      if (s.kind === "pseudo-class" && SELECTOR_ARG.has(s.name) && s.arg !== undefined) {
        const args = argSelectors(s);
        if (s.name === "not") { if (!args.some(touchesRuntime)) kept.push(s.raw); continue; }
        if (args.some(touchesRuntime)) { kept.push(`:${s.name}(${args.map(reachSelector).join(", ")})`); continue; }
      }
      kept.push(s.raw);
    }
    const compound = kept.length === 0 ? "*" : kept.join("");
    parts.push(c.combinator === "" ? compound : c.combinator === " " ? ` ${compound}` : ` ${c.combinator} ${compound}`);
  }
  return parts.join("").trim() || "*";
}
