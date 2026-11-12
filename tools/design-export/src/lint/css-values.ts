/** Small, dependency-free helpers for CSS value text as Chromium serialises it. */

export interface SnapDecl {
  name: string;
  value: string;
  important: boolean;
  /** Set on longhands expanded from a shorthand that was pending var() substitution: the original declaration. */
  via?: string;
  /** The shorthand did not parse after var() substitution (the browser drops it at computed-value time). */
  invalid?: boolean;
}

export const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** Index just past the bracket that closes the one opened at `open` (strings and nested brackets respected). */
export function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { i = endOfString(text, i); continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (stack.length === 0) return i + 1; }
  }
  return text.length;
}

function endOfString(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === q) return j;
  }
  return text.length;
}

/** Splits at top-level separators (outside brackets and strings). " " splits on any whitespace run. */
export function splitTopLevel(text: string, sep: "," | " " | ";" | "/"): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { cur += c + (text[i + 1] ?? ""); i++; continue; }
    if (c === '"' || c === "'") { const e = endOfString(text, i); cur += text.slice(i, e + 1); i = e; continue; }
    if (c === "(" || c === "[" || c === "{") { const e = closeOf(text, i); cur += text.slice(i, e); i = e - 1; continue; }
    if (sep === " " ? /\s/.test(c) : c === sep) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  const trimmed = out.map((s) => s.trim());
  return sep === " " ? trimmed.filter(Boolean) : trimmed;
}

/** Replaces quoted strings and url(...) bodies so token scans do not look inside them. */
export function stripStringsAndUrls(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"' || c === "'") { i = endOfString(v, i); out += '""'; continue; }
    const m = /^url\(/i.exec(v.slice(i, i + 4));
    if (m && !/[\w-]/.test(v[i - 1] ?? "")) { const e = closeOf(v, i + 3); out += "url()"; i = e - 1; continue; }
    out += c;
  }
  return out;
}

/** Every function name in the value (any depth), lowercased, strings and url bodies ignored. */
export function functionNames(value: string): string[] {
  const v = stripStringsAndUrls(value);
  const out: string[] = [];
  const re = /(^|[^\w-])(-?[A-Za-z_][\w-]*)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) { out.push(m[2].toLowerCase()); re.lastIndex = m.index + m[0].length; }
  return out;
}

/** Top-level function calls `name(args)` in order, with their argument text. */
export function functionCalls(value: string): { name: string; args: string; start: number; end: number }[] {
  const out: { name: string; args: string; start: number; end: number }[] = [];
  const re = /(^|[^\w-])(-?[A-Za-z_][\w-]*)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(value, open);
    out.push({ name: m[2].toLowerCase(), args: value.slice(open + 1, end - 1), start: m.index + m[1].length, end });
    re.lastIndex = end;
  }
  return out;
}

/**
 * Substitutes var() references. `lookup` returns a custom property's computed value (already substituted by the
 * browser) or undefined; an empty or missing value uses the fallback (itself substituted), else "".
 */
export function resolveVars(value: string, lookup: (name: string) => string | undefined): string {
  let v = value;
  for (let guard = 0; guard < 1000; guard++) {
    const m = /(^|[^\w-])var\(/i.exec(v);
    if (!m) return v;
    const open = m.index + m[0].length - 1;
    const end = closeOf(v, open);
    const inner = v.slice(open + 1, end - 1);
    const comma = splitTopLevel(inner, ",");
    const name = comma[0].trim();
    const fallback = comma.length > 1 ? inner.slice(inner.indexOf(",") + 1).trim() : undefined;
    const found = lookup(name);
    const rep = found !== undefined && found.trim() !== "" ? found.trim() : fallback ?? "";
    v = v.slice(0, m.index + m[1].length) + rep + v.slice(end);
  }
  return v;
}

/** Declarations of a serialised style block ("a: b; c: d !important;"). */
export function parseDeclarations(cssText: string): SnapDecl[] {
  const out: SnapDecl[] = [];
  for (const part of splitTopLevel(cssText, ";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    out.push({ name: name.startsWith("--") ? name : name.toLowerCase(), value, important });
  }
  return out;
}

/** CSSOM longhands plus, when some are pending var() substitution, the shorthand that carries the var() text. */
export function declsOf(longhands: SnapDecl[], cssText: string): SnapDecl[] {
  const out = longhands.filter((l) => l.value !== "");
  if (longhands.some((l) => l.value === "")) {
    const known = new Set(longhands.map((l) => l.name));
    for (const d of parseDeclarations(cssText)) if (!known.has(d.name) && /var\(/i.test(d.value)) out.push(d);
  }
  return out;
}

/** Family names of a font-family stack, unquoted. */
export function families(stack: string): string[] {
  return splitTopLevel(stack, ",").map((f) => f.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2").replace(/\\(.)/g, "$1")).filter(Boolean);
}

export function firstFamily(stack: string): string { return families(stack)[0] ?? ""; }

/** "16.5156px" → 16.5156; null for anything else. */
export function px(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px\s*$/i.exec(v);
  return m ? Number(m[1]) : v.trim() === "0" ? 0 : null;
}

/** Equal within what Blink's ~6 significant digit serialisation can lose. */
export function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.001, Math.abs(b) * 1e-5);
}

export const LENGTH_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%|em|rem|ex|ch|cm|mm|in|pt|pc|q|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))?$/i;

/** Normalises a colour token for equality checks (case, whitespace). */
export function normColor(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1");
}

export function clip(s: string, n = 80): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
