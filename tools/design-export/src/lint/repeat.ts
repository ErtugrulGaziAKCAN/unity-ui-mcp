import { nonDesign } from "./rules/util.js";
import type { DomSnapshot, SnapElement } from "./snapshot.js";

/**
 * data-u-repeat lists, shared by lint (U-MRK-002, U-MRK-010) and the IR extraction: the first item carries
 * data-u-repeat, the written-out samples follow as siblings with the same tag and classes (is-* runtime state
 * classes ignored), the template is the first item and the samples must share its structure.
 */

/** Class list without runtime state classes (is-*, state-*), sorted. */
export const staticClasses = (e: SnapElement): string =>
  (e.attrs.class ?? "").split(/\s+/).filter((c) => c && !/^(is|state)-/.test(c)).sort().join(" ");

/** Element children that are part of the design (not script/style/template content, line breaks, foreign content). */
export function designChildren(s: DomSnapshot, e: SnapElement): number[] {
  return e.children.filter((k) => {
    const c = s.elements[k];
    if (nonDesign(s)[k]) return false;
    if (c.ns === "html") return c.tag !== "br";
    return c.ns === "svg" && c.tag === "svg";
  });
}

/** The items of a repeat: the data-u-repeat element and the following siblings with its tag and static classes. */
export function repeatSamples(s: DomSnapshot, template: number): number[] {
  const t = s.elements[template];
  const sibs = s.elements[t.parent].children;
  const out = [template];
  for (const k of sibs.slice(sibs.indexOf(template) + 1)) {
    const x = s.elements[k];
    if (x.tag !== t.tag || staticClasses(x) !== staticClasses(t) || x.attrs["data-u-repeat"] !== undefined) break;
    out.push(k);
  }
  return out;
}

/** The repeat template among an element's design children, or undefined. */
export const repeatTemplate = (s: DomSnapshot, e: SnapElement): number | undefined =>
  designChildren(s, e).find((k) => s.elements[k].attrs["data-u-repeat"] !== undefined);

/** Design children with the samples after a repeat template left out (the IR keeps only the template). */
export function itemChildren(s: DomSnapshot, e: SnapElement): number[] {
  const kids = designChildren(s, e);
  const tpl = kids.find((k) => s.elements[k].attrs["data-u-repeat"] !== undefined);
  if (tpl === undefined) return kids;
  const samples = new Set(repeatSamples(s, tpl).slice(1));
  return kids.filter((k) => !samples.has(k));
}

/** Path by position from the screen root (id paths repeat across written-out items). */
export function positionPath(s: DomSnapshot, i: number): string {
  const e = s.elements[i];
  if (e.attrs["data-u-screen"] !== undefined || e.parent < 0) return e.path;
  return `${positionPath(s, e.parent)} > ${e.tag.toLowerCase()}:${s.elements[e.parent].children.indexOf(i)}`;
}
export const describeAt = (s: DomSnapshot, i: number) => `${s.elements[i].path} (${positionPath(s, i)})`;

const IDENTITY = ["data-u-id", "data-u-bind", "data-u-action", "data-l10n", "data-u-arg", "data-u-repeat", "data-u-repeat-mode", "data-u-external"];

/** First structural difference between two items (tags, static classes, ids, keys, binds, text presence, children). */
export function structureDiff(s: DomSnapshot, a: number, b: number, item = true): string | null {
  const x = s.elements[a], y = s.elements[b];
  const pa = () => positionPath(s, a), pb = () => positionPath(s, b);
  if (x.tag !== y.tag || x.ns !== y.ns) return `<${x.tag}> at ${pa()} vs <${y.tag}> at ${pb()}`;
  if (staticClasses(x) !== staticClasses(y)) return `class "${staticClasses(x)}" at ${pa()} vs "${staticClasses(y)}" at ${pb()}`;
  // the items themselves differ by the template's data-u-repeat attributes only
  for (const k of IDENTITY) {
    if (item && k.startsWith("data-u-repeat")) continue;
    if (x.attrs[k] !== y.attrs[k]) return `${k} "${x.attrs[k] ?? ""}" at ${pa()} vs "${y.attrs[k] ?? ""}" at ${pb()}`;
  }
  if ((x.texts.length > 0) !== (y.texts.length > 0)) return `text at ${x.texts.length ? pa() : pb()} only`;
  const ka = itemChildren(s, x), kb = itemChildren(s, y);
  if (ka.length !== kb.length) return `${ka.length} child elements at ${pa()} vs ${kb.length} at ${pb()}`;
  for (let j = 0; j < ka.length; j++) { const r = structureDiff(s, ka[j], kb[j], false); if (r) return r; }
  return null;
}

/** What makes a repeat container unusable: other children than its items, an item that differs from the template, a bad mode. */
export function repeatIssues(s: DomSnapshot, container: number): string[] {
  const e = s.elements[container];
  const tpl = repeatTemplate(s, e);
  if (tpl === undefined) return [];
  const name = s.elements[tpl].attrs["data-u-repeat"];
  const samples = repeatSamples(s, tpl);
  const out: string[] = [];
  const others = designChildren(s, e).filter((k) => !samples.includes(k));
  if (others.length) out.push(`data-u-repeat "${name}": ${others.map((k) => describeAt(s, k)).join(", ")} ${others.length > 1 ? "are" : "is"} not one of its items (a repeat container holds only the items)`);
  samples.slice(1).forEach((x, k) => {
    const why = structureDiff(s, tpl, x);
    if (why) out.push(`data-u-repeat "${name}": item ${k + 2} ${describeAt(s, x)} does not share the structure of the template ${describeAt(s, tpl)}: ${why}`);
  });
  const m = s.elements[tpl].attrs["data-u-repeat-mode"];
  if (m !== undefined && m !== "list" && m !== "inline") out.push(`data-u-repeat-mode "${m}" on ${describeAt(s, tpl)} is not list or inline`);
  return out;
}
