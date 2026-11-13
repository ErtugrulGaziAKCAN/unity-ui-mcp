import { clip, resolveVars, type SnapDecl } from "../css-values.js";
import { isInlineLevel, rendersText, type DomSnapshot, type SnapElement, type SnapRule } from "../snapshot.js";
import type { Finding, Rule } from "../types.js";

export const make = (r: Pick<Rule, "id" | "severity">, path: string, detail: string, fix: string): Finding =>
  ({ ruleId: r.id, severity: r.severity, path, detail, fix });

const memo = <T>(fn: (s: DomSnapshot) => T) => {
  const cache = new WeakMap<DomSnapshot, T>();
  return (s: DomSnapshot): T => { if (!cache.has(s)) cache.set(s, fn(s)); return cache.get(s)!; };
};

/** Inside a data-u-external region (the region's root itself is still part of the screen). */
export const externalDescendant = memo((s) => {
  const out = s.elements.map(() => false);
  for (const e of s.elements) out[e.index] = e.parent >= 0 && (out[e.parent] || s.elements[e.parent].attrs["data-u-external"] !== undefined);
  return out;
});
export const isExternal = (s: DomSnapshot, i: number) => externalDescendant(s)[i];

const NO_TEXT = new Set(["script", "style", "template", "noscript", "title"]);
const SVG_NO_TEXT = new Set(["title", "desc", "style", "script", "metadata"]);
/** Script, style, template… and their descendants: not part of the rendered design. */
export const nonDesign = memo((s) => {
  const out = s.elements.map(() => false);
  for (const e of s.elements) {
    const own = e.ns === "html" ? NO_TEXT.has(e.tag) : SVG_NO_TEXT.has(e.tag);
    out[e.index] = own || (e.parent >= 0 && out[e.parent]);
  }
  return out;
});

/** Elements whose own text (or control text) the screen shows, outside external regions. */
export const textElements = memo((s) => s.elements.filter((e) => rendersText(e) && !nonDesign(s)[e.index] && !isExternal(s, e.index)));

/** Inline-level element in text flow (rich text candidate). */
export const inFlow = (e: SnapElement) => e.ns === "html" && isInlineLevel(e);

/** Inside an inline <svg> (the <svg> root included): exported as a vector asset, not compiled as elements. */
export const inSvg = memo((s) => {
  const out = s.elements.map(() => false);
  for (const e of s.elements) out[e.index] = e.ns === "svg" || (e.parent >= 0 && out[e.parent]);
  return out;
});

export interface Source {
  kind: "rule" | "inline" | "keyframe";
  /** Location for details: `style:0 .card:hover`, `inline style`, `style:0 @keyframes spin 50%`. */
  where: string;
  path: string;
  decls: SnapDecl[];
  /** Elements where pending var() shorthands expand differently from `decls`. */
  declsAt: Record<number, SnapDecl[]>;
  rule: SnapRule | null;
  /** Inline style owner, else -1. */
  owner: number;
  /** Elements reached without a pseudo-element, document order, external regions excluded. */
  elements: number[];
  /** Pseudo-element name → elements reached. */
  pseudo: Map<string, number[]>;
  /** The rule reaches elements, but only inside external regions: nothing of it is compiled. */
  onlyExternal: boolean;
}

/** Every rule and inline style with the elements it reaches; keyframe frames are separate (keyframeSources). */
export const sources = memo((s): Source[] => {
  const out: Source[] = [];
  const keep = (i: number) => !isExternal(s, i) && !nonDesign(s)[i];
  for (const r of s.rules) {
    const els = new Set<number>(), pseudo = new Map<string, number[]>();
    let any = false;
    for (const sel of r.selectors) {
      const m = sel.elements ?? [];
      if (m.length) any = true;
      const kept = m.filter(keep);
      if (sel.pseudoElement) pseudo.set(sel.pseudoElement, Array.from(new Set([...(pseudo.get(sel.pseudoElement) ?? []), ...kept])).sort((a, b) => a - b));
      else kept.forEach((i) => els.add(i));
    }
    const elements = Array.from(els).sort((a, b) => a - b);
    const reached = elements.length > 0 || Array.from(pseudo.values()).some((v) => v.length > 0);
    out.push({ kind: "rule", where: r.path, path: r.path, decls: r.decls, declsAt: r.declsAt, rule: r, owner: -1, elements, pseudo, onlyExternal: any && !reached });
  }
  for (const e of s.elements) {
    if (!e.inline || !keep(e.index)) continue;
    out.push({ kind: "inline", where: "inline style", path: e.path, decls: e.inline, declsAt: {}, rule: null, owner: e.index, elements: [e.index], pseudo: new Map(), onlyExternal: false });
  }
  return out;
});

/** Sources (rules and inline styles) reaching each element, in cascade order. */
export const sourcesOf = memo((s): Source[][] => {
  const out: Source[][] = s.elements.map(() => []);
  for (const src of sources(s)) for (const i of src.elements) out[i].push(src);
  return out;
});

export const keyframeSources = memo((s): Source[] => s.keyframes.flatMap((k) => k.frames.map((f) => ({
  kind: "keyframe" as const, where: `${k.path} ${f.key}`, path: k.path, decls: f.decls, declsAt: {}, rule: null, owner: -1, elements: [],
  pseudo: new Map<string, number[]>(), onlyExternal: false,
}))));

/** var() lookup at an element (walking up to the root), or at the root. */
export function lookup(s: DomSnapshot, i: number | null) {
  return (name: string): string | undefined => {
    for (let k = i ?? -1; k >= 0; k = s.elements[k].parent) if (name in s.elements[k].vars) return s.elements[k].vars[name];
    return s.rootVars[name];
  };
}
export const resolved = (s: DomSnapshot, value: string, i: number | null) => resolveVars(value, lookup(s, i));

export interface Target { path: string; element: SnapElement | null; more: number }

/**
 * Where a source's finding is reported: its first reached element (or first element of `pseudo`), else the rule
 * itself; null when it only reaches external regions.
 */
export function targetOf(s: DomSnapshot, src: Source, pseudo?: string): Target | null {
  if (src.onlyExternal) return null;
  const list = pseudo !== undefined ? src.pseudo.get(pseudo) ?? [] : src.elements.length ? src.elements : Array.from(src.pseudo.values()).flat().sort((a, b) => a - b);
  if (list.length) return { path: s.elements[list[0]].path, element: s.elements[list[0]], more: list.length - 1 };
  return { path: src.path, element: null, more: 0 };
}

/** " [style:0 .card; 3 more elements]" style suffix for details. */
export function at(src: Source, t: Target): string {
  const where = src.kind === "inline" ? "inline style" : src.where;
  const more = t.more > 0 ? `; also ${t.more} more element${t.more > 1 ? "s" : ""}` : "";
  return ` [${where}${more}]`;
}

export const declText = (d: SnapDecl, value?: string) => `${d.via && !d.invalid ? `${d.name} (from ${clip(d.via, 60)})` : d.name}: ${clip(value ?? d.value)}`;

/** Collects details per path so a rule reports one finding per element or rule. */
export class Collector {
  private map = new Map<string, string[]>();
  add(path: string, detail: string) {
    const l = this.map.get(path) ?? [];
    if (!l.includes(detail)) l.push(detail);
    this.map.set(path, l);
  }
  has(path: string) { return this.map.has(path); }
  findings(r: Pick<Rule, "id" | "severity">, fix: string | ((path: string) => string)): Finding[] {
    return Array.from(this.map, ([path, d]) => make(r, path, d.join("; "), typeof fix === "string" ? fix : fix(path)));
  }
}

/** Declarations of a source as they apply at element `i` (pending var() shorthands expanded there). */
export const declsAt = (src: Source, i: number | null): SnapDecl[] => (i !== null && src.declsAt[i]) || src.decls;
const varDependent = (src: Source) => Object.keys(src.declsAt).length > 0 || src.decls.some((d) => /var\(/i.test(d.value));

/**
 * Elements a source's declarations are judged at: every reached element when a value depends on var() (custom
 * properties may differ per element), else only the first; `null` stands for the rule itself.
 */
export function judgeAt(s: DomSnapshot, src: Source, t: Target): (number | null)[] {
  if (t.element === null) return [null];
  return varDependent(src) && src.elements.length > 1 ? src.elements : [t.element.index];
}

/**
 * Shared shape of the declaration rules: for every source, the declarations `bad` flags (value var()-resolved at the
 * element judged), one finding per source at the first element where something is flagged.
 */
export function declRule(
  s: DomSnapshot,
  r: Pick<Rule, "id" | "severity">,
  fix: string,
  bad: (d: SnapDecl, value: string, src: Source, t: Target) => string | null,
  opts: { keyframes?: boolean; pseudo?: boolean } = {},
): Finding[] {
  const c = new Collector();
  const all = opts.keyframes ? [...sources(s), ...keyframeSources(s)] : sources(s);
  for (const src of all) {
    const t0 = targetOf(s, src);
    if (!t0) continue;
    if (!opts.pseudo && src.kind === "rule" && src.elements.length === 0 && src.pseudo.size > 0) continue;
    for (const i of judgeAt(s, src, t0)) {
      const t: Target = i === null ? t0 : { path: s.elements[i].path, element: s.elements[i], more: t0.more };
      const hits: string[] = [];
      for (const d of declsAt(src, i)) {
        if (d.name.startsWith("--")) continue;
        const why = bad(d, resolved(s, d.value, i), src, t);
        if (why !== null) hits.push(why);
      }
      if (hits.length) { c.add(t.path, hits.join(", ") + at(src, t)); break; }
    }
  }
  return c.findings(r, fix);
}
