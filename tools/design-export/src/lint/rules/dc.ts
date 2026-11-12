import type { DcDynamic } from "../../load.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/** Rules over the Design Component features unwrapDcHtml reports (spec 5.5). */
export function dcRule(id: string, kinds: DcDynamic["kind"][], what: (d: DcDynamic) => string, fix: string): Rule {
  const r: Rule = {
    id, severity: "error",
    check: (_s, _k, _b, ctx) => ctx.dynamic.filter((d) => kinds.includes(d.kind)).map((d) => make(r, "document", what(d), fix)),
  };
  return r;
}
