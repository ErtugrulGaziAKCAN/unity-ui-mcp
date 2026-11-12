import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-NET-002", severity: "error",
  check(_s, _k, _b, ctx) {
    const blob = new Set(ctx.unresolvedBlobs);
    const out = ctx.unresolvedBlobs.map((id) => make(rule, "document", `canvas asset /_blob/${id} is not in blobs.json`,
      "Fetch the /_blob/<id> upload next to the artboard and map it in blobs.json (blob id → local file)."));
    for (const m of ctx.missing) {
      const id = /^\/_blob\/([A-Za-z0-9_-]+)/.exec(m)?.[1];
      if (id && blob.has(id)) continue;
      out.push(make(rule, "document", `missing file ${m}`, "Add the file next to the design (path relative to the HTML) or fix the reference."));
    }
    return out;
  },
};
