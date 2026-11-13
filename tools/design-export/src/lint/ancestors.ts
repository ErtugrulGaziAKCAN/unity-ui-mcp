import { isExternal } from "./rules/util.js";
import type { DomSnapshot, SnapSelector } from "./snapshot.js";

/**
 * The ancestor a state compound before the subject names (`.card:hover .title`, `.row.is-selected .name`), for an
 * element the selector reaches. Shared by lint (U-CSS-027) and the IR extraction, which writes it as an
 * `anc(<id>):<state>` layer, so both accept and reject the same selectors with the same message.
 */
export function stateAncestor(s: DomSnapshot, sel: SnapSelector, d: SnapSelector["dynamicAncestors"][number], i: number): { index: number } | { problem: string } {
  const compound = sel.parsed.compounds[d.compound].simples.map((x) => x.raw).join("");
  const at = s.elements[i].path;
  if (d.bare) return { problem: `"${compound}" in "${sel.text}" names a state but not the ancestor of ${at} that has it; write the ancestor's class with it (for example .card${compound} …)` };
  const m = d.matches[i] ?? [];
  if (m.length === 0) return { problem: `"${compound}" in "${sel.text}" matches no ancestor of ${at} inside the screen; give the ancestor that takes the state a class (for example .row${compound} …)` };
  if (m.length > 1) return { problem: `"${compound}" in "${sel.text}" matches ${m.length} ancestors of ${at} (${m.map((a) => s.elements[a].path).join(", ")}); it must match exactly one` };
  if (isExternal(s, m[0])) return { problem: `"${compound}" in "${sel.text}" matches ${s.elements[m[0]].path}, which is not part of the compiled screen` };
  return { index: m[0] };
}
