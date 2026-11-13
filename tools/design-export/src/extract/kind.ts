import type { NodeKind } from "../ir/types.js";
import { cssSupport } from "../lint/allowed-css.js";
import type { DomSnapshot, SnapElement } from "../lint/snapshot.js";
import { isTextElement } from "../lint/text-runs.js";

export { designChildren as compiledChildren } from "../lint/repeat.js";
export { isRichInline, isTextElement, RICH_TAGS } from "../lint/text-runs.js";

/** Input types that compile to a text field (the allowed input types other than toggles). */
export const TEXT_INPUT_TYPES = new Set(cssSupport.inputTypes.filter((t) => t !== "checkbox" && t !== "radio"));

const inputType = (e: SnapElement) => (e.attrs.type ?? "text").toLowerCase();

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

export const isScroll = (e: SnapElement) => /^(auto|scroll)$/.test(e.computed["overflow-x"] ?? "") || /^(auto|scroll)$/.test(e.computed["overflow-y"] ?? "");

/**
 * Kind table (plan Task 8). `list` is decided by the tree (a repeat container in list mode), and so is a text
 * element whose keyed inline runs become nodes of their own (a container); without the snapshot an element counts as
 * text only when it has direct text and no element children.
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
        throw new Error(`${el.path}: <input type="${t}"> has no IR kind (only ${Array.from(TEXT_INPUT_TYPES).join(", ")}, checkbox and radio inputs compile)`);
      }
    }
  }
  if (backgroundImageOnly(el)) return "image";
  if (isScroll(el)) return "scroll";
  if (s ? isTextElement(s, el) : el.texts.length > 0 && el.children.length === 0) return "text";
  return "container";
}
