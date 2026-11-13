import type { IrText } from "../ir/types.js";
import { px } from "../lint/css-values.js";
import type { DomSnapshot, SnapElement } from "../lint/snapshot.js";
import type { TextStyle } from "../lint/text-styles.js";
import { isRichInline } from "./kind.js";
import { fmt } from "./naming.js";
import { normalizeColor } from "./styles.js";

/** An element's child nodes in order: text, or an element by snapshot index. */
export type ChildSeq = ({ t: string } | { e: number })[];

type Tok = { text: string } | { tag: string } | { br: true };

const weight = (e: SnapElement) => Number(e.computed["font-weight"]) || 400;
const italic = (e: SnapElement) => /italic|oblique/.test(e.computed["font-style"] ?? "");

/** Elements whose child order the page must report: those with element children, inside the given subtrees. */
export function sequencesNeeded(s: DomSnapshot, roots: number[]): number[] {
  const out = new Set<number>();
  const walk = (i: number) => {
    const e = s.elements[i];
    if (e.children.length === 0) return;
    out.add(i);
    e.children.forEach(walk);
  };
  roots.forEach(walk);
  return Array.from(out).sort((a, b) => a - b);
}

/** TextCore tags for a rich child against its parent: colour, size, bold, italic (spec 5.3). */
function tagsFor(c: SnapElement, p: SnapElement, styles: TextStyle[]): [string, string][] {
  const out: [string, string][] = [];
  const col = normalizeColor(c.computed.color ?? ""), pcol = normalizeColor(p.computed.color ?? "");
  if (col !== pcol) out.push([`<color=${col.startsWith("#") ? col : rgbaHex(col)}>`, "</color>"]);
  const size = px(c.computed["font-size"]), psize = px(p.computed["font-size"]);
  if (size !== null && psize !== null && Math.abs(size - psize) > 0.001) {
    const exact = styles.find((st) => st.name === c.textStyle)?.fontSize ?? size;
    out.push([`<size=${fmt(exact)}px>`, "</size>"]);
  }
  if (weight(c) >= 600 && weight(p) < 600) out.push(["<b>", "</b>"]);
  if (italic(c) && !italic(p)) out.push(["<i>", "</i>"]);
  return out;
}

function rgbaHex(rgba: string): string {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  if (!m) return rgba;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("") + Math.round(Number(m[4]) * 255).toString(16).padStart(2, "0");
}

function tokens(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[], rich: boolean, deep: boolean): Tok[] {
  const e = s.elements[i];
  const seq: ChildSeq = seqs.get(i) ?? e.texts.map((t) => ({ t }));
  const out: Tok[] = [];
  for (const item of seq) {
    if ("t" in item) { out.push({ text: item.t }); continue; }
    const c = s.elements[item.e];
    if (!c) continue;
    if (c.ns === "html" && c.tag === "br") { out.push({ br: true }); continue; }
    if (!deep && !isRichInline(s, c)) continue;
    const tags = rich && isRichInline(s, c) ? tagsFor(c, e, styles) : [];
    for (const [open] of tags) out.push({ tag: open });
    out.push(...tokens(s, item.e, seqs, styles, rich, deep));
    for (const [, close] of tags.reverse()) out.push({ tag: close });
  }
  return out;
}

/** Joins tokens the way CSS lays the text out: whitespace collapsed (unless preserved), trimmed at line edges. */
function render(toks: Tok[], preserve: boolean): string {
  if (preserve) return toks.map((t) => ("text" in t ? t.text : "tag" in t ? t.tag : "\n")).join("");
  let out = "", space = false, start = true;
  for (const t of toks) {
    if ("br" in t) { out += "\n"; space = false; start = true; continue; }
    if ("tag" in t) {
      if (space) { out += " "; space = false; }
      out += t.tag;
      continue;
    }
    for (const ch of t.text.replace(/[ \t\n\r\f]+/g, " ")) {
      if (ch === " ") { if (!start) space = true; continue; }
      if (space) { out += " "; space = false; }
      out += ch;
      start = false;
    }
  }
  return out;
}

const preserves = (e: SnapElement) => (e.computed["white-space-collapse"] ?? "collapse") !== "collapse";

/** Rendered text of a text element with rich-text tags; `rich` when a tag was written. */
export function richText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[]): { text: string; rich: boolean } {
  const toks = tokens(s, i, seqs, styles, true, false);
  return { text: render(toks, preserves(s.elements[i])), rich: toks.some((t) => "tag" in t) };
}

/** Rendered text of any subtree without tags (sample values for fixtures). */
export function plainText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>): string {
  const e = s.elements[i];
  if (e.ns === "html" && (e.tag === "input" || e.tag === "textarea")) return e.attrs.value ?? "";
  return render(tokens(s, i, seqs, [], false, true), preserves(e));
}

const args = (e: SnapElement) => (e.attrs["data-l10n-args"] ?? "").split(",").map((a) => a.trim()).filter(Boolean);

/** IrText of a text node, a text-only button or label, a text field (value, else placeholder) or a dropdown (selected option). */
export function irText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[]): IrText | null {
  const e = s.elements[i];
  const style = e.textStyle ?? null;
  if (e.ns === "html" && (e.tag === "input" || e.tag === "textarea")) {
    const value = e.tag === "textarea" ? plainText(s, i, seqs) : e.attrs.value ?? "";
    if (value) return { key: null, tr: value, en: null, args: [], rich: false, style };
    const ph = e.attrs.placeholder;
    if (ph === undefined) return null;
    return { key: e.attrs["data-l10n-placeholder"] ?? null, tr: ph, en: e.attrs["data-en-placeholder"] ?? null, args: [], rich: false, style };
  }
  if (e.ns === "html" && e.tag === "select") {
    const opts = e.children.map((k) => s.elements[k]).filter((o) => o.tag === "option");
    const o = opts.find((x) => x.attrs.selected !== undefined) ?? opts[0];
    if (!o) return null;
    return { key: o.attrs["data-l10n"] ?? null, tr: plainText(s, o.index, seqs), en: o.attrs["data-en"] ?? null, args: args(o), rich: false, style };
  }
  const t = richText(s, i, seqs, styles);
  return { key: e.attrs["data-l10n"] ?? null, tr: t.text, en: e.attrs["data-en"] ?? null, args: args(e), rich: t.rich, style };
}
