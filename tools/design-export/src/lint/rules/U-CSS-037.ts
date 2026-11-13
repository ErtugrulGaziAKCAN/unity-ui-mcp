import { classifyKind, isScroll } from "../../extract/kind.js";
import { repeatTemplate } from "../repeat.js";
import { layoutOf } from "../layout.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import { isTextElement, runPlans } from "../text-runs.js";
import type { Rule } from "../types.js";
import { splitTopLevel } from "../css-values.js";
import { Collector, resolved } from "./util.js";

/** Kind of node the element compiles to, and whether the node draws its own text (as the IR extraction decides). */
function nodeOf(s: DomSnapshot, e: SnapElement): { kind: string; text: boolean } {
  let kind: string;
  try { kind = classifyKind(e, s); } catch { kind = "unsupported"; } // U-CSS-029
  const run = runPlans(s).get(e.index);
  if (run) kind = e.ns === "html" && e.tag === "button" ? "button" : "container";
  const tpl = repeatTemplate(s, e);
  if (tpl !== undefined) {
    let scroll = false;
    for (let k = e.index; k >= 0 && !scroll; k = s.elements[k].parent) scroll = isScroll(s.elements[k]);
    const mode = s.elements[tpl].attrs["data-u-repeat-mode"] ?? (scroll ? "list" : "inline");
    if (mode === "list") kind = "list";
  }
  const text = !run && (kind === "text" || kind === "input" || kind === "dropdown" || (kind === "button" && isTextElement(s, e)));
  return { kind, text };
}

const URL = /url\(/i, GRADIENT = /gradient\(/i;
const inset = (v: string) => splitTopLevel(v, ",").some((item) => /(^|\s)inset(\s|$)/i.test(item));

/**
 * Baked effects UI Toolkit cannot stack on one element. An inset shadow becomes an overlay child above the background
 * and below the content, so it cannot sit under the element's own text (drawn below children), a form control's parts
 * or scrolled content. An element has one background image with one geometry: a url() image cannot share it with a
 * gradient in another layer, and only the base layer's url() image is drawn with CSS background geometry. A tintable
 * icon (an inline SVG painted with currentColor) is tinted as the element's background, so it cannot also have a
 * background image or an inset shadow.
 */
export const rule: Rule = {
  id: "U-CSS-037", severity: "error",
  check(s) {
    const L = layoutOf(s);
    const c = new Collector();
    const fixes = new Map<string, Set<string>>();
    const add = (e: SnapElement, detail: string, fix: string) => { c.add(e.path, detail); fixes.set(e.path, (fixes.get(e.path) ?? new Set()).add(fix)); };
    for (const e of s.elements) {
      if (!L.inScreen(e.index)) continue;
      const cands = L.cands(e.index);
      const values = (prop: string) => cands.filter((x) => x.prop === prop).map((x) => ({ key: x.key, base: x.dims.length === 0, v: resolved(s, x.entry.value, e.index).trim() }));
      const shadows = values("box-shadow").filter((x) => x.v !== "none" && inset(x.v));
      const images = values("background-image").filter((x) => x.v !== "none");
      if (!shadows.length && !images.length) continue;
      const { kind, text } = nodeOf(s, e);
      const where = (list: { key: string }[]) => Array.from(new Set(list.map((x) => x.key))).join(", ");
      if (shadows.length) {
        if (text) add(e, `an inset box-shadow (${where(shadows)}) on an element with its own text: UI Toolkit draws the text below the shadow overlay`, "Put the text in a child element of the shadowed box.");
        else if (kind === "input" || kind === "toggle" || kind === "dropdown") add(e, `an inset box-shadow (${where(shadows)}) on a form control (${kind}): the control draws its own parts above the shadow overlay`, "Put the inset shadow on a wrapper element behind the control.");
        else if (kind === "scroll" || kind === "list") add(e, `an inset box-shadow (${where(shadows)}) on a scroll area: the shadow overlay would scroll with the content`, "Put the inset shadow on a wrapper element around the scroll area.");
      }
      // one declaration with both is U-CSS-014 (several images)
      const urls = images.filter((x) => URL.test(x.v) && !GRADIENT.test(x.v)), gradients = images.filter((x) => GRADIENT.test(x.v) && !URL.test(x.v));
      if (urls.length && gradients.length) {
        add(e, `a url() background image (${where(urls)}) and a gradient (${where(gradients)}): UI Toolkit draws one background image per element with one geometry`, "Put the gradient or the image on a child element.");
      } else if (urls.length && !urls.some((x) => x.base)) {
        add(e, `a url() background image only in ${where(urls)}: only the base layer's url() image is drawn with its natural size and CSS background geometry`, "Give the base layer the url() image too (a layer may switch to another image or to none), or put the image on a child element shown in that state.");
      }
      if (e.ns === "svg" && e.tag === "svg" && e.svgPaint === "current" && (images.length || shadows.length)) {
        add(e, `a tintable icon (painted with currentColor) with ${images.length ? `a background image (${where(images)})` : `an inset box-shadow (${where(shadows)})`}: the icon is tinted as the element's own background image`, "Put the icon in a child element of the background or the shadowed box.");
      }
    }
    return c.findings(rule, (path) => Array.from(fixes.get(path) ?? []).join(" "));
  },
};
