import type { IrText } from "../ir/types.js";
import { px } from "../lint/css-values.js";
import { TEXT_ATTRS } from "../lint/rules/U-MRK-007.js";
import type { DomSnapshot, SnapElement } from "../lint/snapshot.js";
import { argSpans, isArg, isRichInline } from "../lint/text-runs.js";
import type { TextStyle } from "../lint/text-styles.js";
import { fmt } from "./naming.js";
import { normalizeColor } from "./styles.js";

/** An element's child nodes in order: text, or an element by snapshot index. */
export type ChildSeq = ({ t: string } | { e: number })[];
/** Rendered text (innerText) per element, measured where the element renders; null when it never does. */
export type Rendered = Map<number, string | null>;

type Tok = { text: string } | { tag: string; open: boolean } | { br: true } | { arg: string; inner: Tok[] };

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

function rgbaHex(rgba: string): string {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  if (!m) return rgba;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("") + Math.round(Number(m[4]) * 255).toString(16).padStart(2, "0");
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

/** `rich`: rich-text tags and {arg} placeholders (a text node); else plain sample text of any subtree. */
function tokens(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[], rich: boolean): Tok[] {
  const e = s.elements[i];
  const seq: ChildSeq = seqs.get(i) ?? e.texts.map((t) => ({ t }));
  const out: Tok[] = [];
  for (const item of seq) {
    if ("t" in item) { out.push({ text: item.t }); continue; }
    const c = s.elements[item.e];
    if (!c) continue;
    if (c.ns === "html" && c.tag === "br") { out.push({ br: true }); continue; }
    const tags = rich && isRichInline(s, c) ? tagsFor(c, e, styles) : [];
    for (const [open] of tags) out.push({ tag: open, open: true });
    if (rich && isArg(c)) out.push({ arg: c.attrs["data-u-arg"], inner: tokens(s, item.e, seqs, styles, false) });
    else if (rich && !isRichInline(s, c)) continue;
    else out.push(...tokens(s, item.e, seqs, styles, rich));
    for (const [, close] of tags.reverse()) out.push({ tag: close, open: false });
  }
  return out;
}

const WS = /[ \t\n\r\f]/;

/** Joins the tokens as the browser rendered them: each raw character kept or collapsed as in `rendered`; null on mismatch. */
function align(toks: Tok[], rendered: string): string | null {
  let p = 0, out = "", ok = true;
  const text = (t: string, emit: boolean) => {
    for (const ch of t) {
      if (!ok) return;
      const r = rendered[p];
      if (ch === " ") {
        if (r === " " || r === " ") { if (emit) out += ch; p++; } else ok = false;
      } else if (WS.test(ch)) {
        if (r !== undefined && WS.test(r)) { if (emit) out += r; p++; }
      } else if (r === ch) { if (emit) out += ch; p++; } else ok = false;
    }
  };
  const walk = (list: Tok[], emit: boolean) => {
    for (const t of list) {
      if (!ok) return;
      if ("text" in t) text(t.text, emit);
      else if ("tag" in t) { if (emit) out += t.tag; }
      else if ("br" in t) { if (rendered[p] === "\n") { if (emit) out += "\n"; p++; } }
      else { walk(t.inner, false); if (emit) out += `{${t.arg}}`; }
    }
  };
  walk(toks, true);
  return ok && p === rendered.length ? out : null;
}

/** CSS whitespace collapse without a rendering: first collapsible space of a run kept, across inline tags. */
function collapse(toks: Tok[], preserve: boolean): string {
  let out = "", space = false, lastSpace = false, start = true;
  const glyph = (g: string) => { if (space) { out += " "; space = false; } out += g; start = false; lastSpace = false; };
  const walk = (list: Tok[]) => {
    for (const t of list) {
      if ("br" in t) { out += "\n"; space = false; start = true; lastSpace = false; continue; }
      if ("tag" in t) {
        if (t.open && space) { out += " "; space = false; lastSpace = true; }
        out += t.tag;
        continue;
      }
      if ("arg" in t) { glyph(`{${t.arg}}`); continue; }
      if (preserve) { out += t.text; start = false; continue; }
      for (const ch of t.text.replace(/[ \t\n\r\f]+/g, " ")) {
        if (ch === " ") { if (!start && !lastSpace) space = true; continue; }
        glyph(ch);
      }
    }
  };
  walk(toks);
  return out;
}

const preserves = (e: SnapElement) => (e.computed["white-space-collapse"] ?? "collapse") !== "collapse";

const render = (toks: Tok[], e: SnapElement, rendered: string | null | undefined) =>
  (rendered != null ? align(toks, rendered) : null) ?? collapse(toks, preserves(e));

/**
 * A keyed text's English entry as the import reads it with the reference locale English: the visible words (no rich tags),
 * whitespace and entities rendered as in the exported `ref`. The lint compares `data-en` with this.
 */
export function englishEntry(toks: Tok[], preserve: boolean, rendered: string | null | undefined): string {
  return (rendered != null ? align(toks, rendered) : null) ?? collapse(toks, preserve);
}

/** Text of a text node: rich-text tags, {arg} placeholders; `rich` when a tag was written. */
export function richText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[], rendered: Rendered): { text: string; rich: boolean } {
  const toks = tokens(s, i, seqs, styles, true);
  const hasTag = (l: Tok[]): boolean => l.some((t) => "tag" in t);
  return { text: render(toks, s.elements[i], rendered.get(i)), rich: hasTag(toks) };
}

/** Rendered text of any subtree without tags (sample values for fixtures). */
export function plainText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, rendered: Rendered): string {
  const e = s.elements[i];
  if (e.ns === "html" && e.tag === "input") return e.attrs.value ?? "";
  return render(tokens(s, i, seqs, [], false), e, rendered.get(i));
}

/** IrText of a text node, a text-only button, a text field (its value) or a dropdown (selected option). */
export function irText(s: DomSnapshot, i: number, seqs: Map<number, ChildSeq>, styles: TextStyle[], rendered: Rendered): IrText | null {
  const e = s.elements[i];
  const style = e.textStyle ?? null;
  if (e.ns === "html" && (e.tag === "input" || e.tag === "textarea")) {
    const value = plainText(s, i, seqs, rendered);
    return value ? { key: null, ref: value, en: null, args: [], rich: false, style } : null;
  }
  if (e.ns === "html" && e.tag === "select") {
    const opts = e.children.map((k) => s.elements[k]).filter((o) => o.tag === "option");
    const o = opts.find((x) => x.attrs.selected !== undefined) ?? opts[0];
    if (!o) return null;
    return { key: o.attrs["data-l10n"] ?? null, ref: plainText(s, o.index, seqs, rendered), en: o.attrs["data-en"] ?? null, args: [], rich: false, style };
  }
  const t = richText(s, i, seqs, styles, rendered);
  const args = argSpans(s, i).map((k) => s.elements[k].attrs["data-u-arg"]);
  return { key: e.attrs["data-l10n"] ?? null, ref: t.text, en: e.attrs["data-en"] ?? null, args, rich: t.rich, style };
}

/** Attribute texts: placeholder (drawn with the field's text style), title, alt, aria-label. */
export function attrTexts(e: SnapElement): Record<string, IrText> {
  const out: Record<string, IrText> = {};
  for (const a of TEXT_ATTRS) {
    const v = e.attrs[a];
    if (v === undefined || v.trim() === "") continue;
    out[a] = { key: e.attrs[`data-l10n-${a}`] ?? null, ref: v, en: e.attrs[`data-en-${a}`] ?? null, args: [], rich: false, style: a === "placeholder" ? e.textStyle ?? null : null };
  }
  return out;
}
