import { px } from "../css-values.js";
import type { SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { Collector, inFlow, inSvg, isExternal, nonDesign } from "./util.js";

const BLOCK = new Set(["block", "list-item"]);
const nz = (v: string | undefined) => (px(v) ?? 0) !== 0;
const inFlowBlock = (e: SnapElement) =>
  e.rendered && e.ns === "html" && BLOCK.has(e.computed.display) && e.computed.position !== "absolute" && e.computed.position !== "fixed" && e.computed.float === "none";

/**
 * Layouts the flex lowering cannot reproduce: vertical margins that CSS collapses in block flow (the lowering turns
 * block containers into flex columns, where margins add up), and text next to child elements in a flex container
 * (an anonymous flex item, which UI Toolkit has no equivalent for).
 */
export const rule: Rule = {
  id: "U-CSS-030", severity: "error",
  check(s) {
    const c = new Collector();
    const fixes = new Map<string, string>();
    const add = (path: string, detail: string, fix: string) => { c.add(path, detail); fixes.set(path, fix); };
    const el = (i: number) => s.elements[i];
    for (const e of s.elements) {
      if (e.ns !== "html" || inSvg(s)[e.index] || isExternal(s, e.index) || nonDesign(s)[e.index] || !e.rendered) continue;
      const kids = e.children.map(el).filter((k) => !nonDesign(s)[k.index] && k.computed.display !== "none");
      // text beside element children
      if (e.texts.length && kids.length) {
        const flex = /flex|grid/.test(e.computed.display);
        const blockKids = kids.filter((k) => !inFlow(k) && k.tag !== "br");
        if (flex || blockKids.length) {
          add(e.path, flex ? `text "${e.texts.join(" ").trim().slice(0, 40)}" sits next to child elements in a ${e.computed.display} container (anonymous flex item)`
            : `text "${e.texts.join(" ").trim().slice(0, 40)}" sits next to block children (anonymous block)`, "Wrap the text in its own element (for example a span or p with data-l10n).");
        }
      }
      if (!BLOCK.has(e.computed.display)) continue;
      // adjacent vertical margins of block siblings
      const blocks = kids.filter(inFlowBlock);
      for (let k = 0; k + 1 < blocks.length; k++) {
        const a = blocks[k], b = blocks[k + 1];
        if (nz(a.computed["margin-bottom"]) && nz(b.computed["margin-top"])) {
          add(e.path, `margins collapse between ${a.path.split(" > ").pop()} (margin-bottom ${a.computed["margin-bottom"]}) and ${b.path.split(" > ").pop()} (margin-top ${b.computed["margin-top"]})`,
            "Use display: flex with flex-direction: column and gap or one-sided margins; adjacent vertical margins collapse in CSS block flow but add up in UI Toolkit.");
        }
      }
      // a first child's top margin collapsing through its parent
      const parent = e.parent >= 0 ? el(e.parent) : null;
      const first = blocks[0];
      if (parent && BLOCK.has(parent.computed.display) && inFlowBlock(e) && first && first === kids[0] && nz(first.computed["margin-top"]) &&
        !nz(e.computed["padding-top"]) && !nz(e.computed["border-top-width"]) && e.computed["overflow-y"] === "visible" && e.computed["overflow-x"] === "visible") {
        add(e.path, `the top margin of ${first.path.split(" > ").pop()} (${first.computed["margin-top"]}) collapses through this element`,
          "Give the parent padding-top instead of the child's margin-top, or make the parent a flex column; parent and child top margins collapse in CSS block flow.");
      }
    }
    return c.findings(rule, (path) => fixes.get(path) ?? "");
  },
};
