import type { NodeKind } from "../ir/types.js";
import { nonDesign } from "../lint/rules/util.js";
import type { DomSnapshot, SnapElement } from "../lint/snapshot.js";

/** Inline tags that stay inside a text node as TextCore rich text (spec 5.3); `br` is a line break. */
export const RICH_TAGS = new Set(["b", "strong", "i", "em", "span", "br"]);
export const TEXT_INPUT_TYPES = new Set(["text", "search", "password", "number"]);
const NO_TEXT = new Set(["script", "style", "template", "noscript", "title"]);

const inputType = (e: SnapElement) => (e.attrs.type ?? "text").toLowerCase();

/** An inline rich-text child (b, strong, i, em, span in text flow, br) whose own content is text or rich children. */
export function isRichInline(s: DomSnapshot, c: SnapElement): boolean {
  if (c.ns !== "html" || !RICH_TAGS.has(c.tag)) return false;
  if (c.tag === "br") return true;
  if (!c.computed.display.startsWith("inline") || c.attrs["data-u-repeat"] !== undefined) return false;
  return c.children.every((k) => isRichInline(s, s.elements[k]));
}

/** An element whose content is text with optional rich inline children (at least one character somewhere). */
export function isTextElement(s: DomSnapshot | undefined, e: SnapElement): boolean {
  if (e.ns !== "html" || NO_TEXT.has(e.tag)) return false;
  if (!s) return e.texts.length > 0 && e.children.length === 0;
  if (!e.children.every((k) => isRichInline(s, s.elements[k]))) return false;
  const hasText = (x: SnapElement): boolean => x.texts.length > 0 || x.children.some((k) => hasText(s.elements[k]));
  return hasText(e);
}

/** Painted only by a background-image url(): no colour, border, shadow, gradient, text or children. */
function backgroundImageOnly(e: SnapElement): boolean {
  const c = e.computed;
  const bg = c["background-image"] ?? "none";
  if (!/^url\(/i.test(bg.trim()) || /gradient\(/i.test(bg) || bg.includes("), ")) return false;
  if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c["background-color"] ?? "")) return false;
  if (["top", "right", "bottom", "left"].some((sd) => c[`border-${sd}-width`] !== "0px")) return false;
  if ((c["box-shadow"] ?? "none") !== "none") return false;
  return e.children.length === 0 && e.texts.length === 0;
}

const scrolls = (e: SnapElement) => /^(auto|scroll)$/.test(e.computed["overflow-x"] ?? "") || /^(auto|scroll)$/.test(e.computed["overflow-y"] ?? "");
export const isScroll = scrolls;

/**
 * Kind table (plan Task 8). `list` is decided by the tree (a repeat container in list mode); without the snapshot
 * an element counts as text only when it has direct text and no element children.
 */
export function classifyKind(el: SnapElement, s?: DomSnapshot): NodeKind {
  if (el.ns === "svg") return "vector";
  if (el.ns === "html") {
    switch (el.tag) {
      case "button": return "button";
      case "select": return "dropdown";
      case "textarea": return "input";
      case "img": return "image";
      case "input": {
        const t = inputType(el);
        if (t === "checkbox" || t === "radio") return "toggle";
        if (TEXT_INPUT_TYPES.has(t)) return "input";
        throw new Error(`${el.path}: <input type="${t}"> has no IR kind (only text, search, password, number, checkbox and radio inputs compile)`);
      }
    }
  }
  if (backgroundImageOnly(el)) return "image";
  if (scrolls(el)) return "scroll";
  if (isTextElement(s, el)) return "text";
  return "container";
}

/** Element children that become IR nodes (not script/style/template content, line breaks or foreign content). */
export function compiledChildren(s: DomSnapshot, e: SnapElement): number[] {
  return e.children.filter((k) => {
    const c = s.elements[k];
    if (nonDesign(s)[k]) return false;
    if (c.ns === "html") return c.tag !== "br";
    return c.ns === "svg" && c.tag === "svg";
  });
}
