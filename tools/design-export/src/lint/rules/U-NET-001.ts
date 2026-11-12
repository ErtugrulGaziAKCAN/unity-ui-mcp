import type { Rule } from "../types.js";
import { make } from "./util.js";

export const rule: Rule = {
  id: "U-NET-001", severity: "error",
  check: (_s, _k, blocked) => blocked.map((b) => make(rule, "document", `blocked ${b.type} ${b.url}`,
    "Do not load remote resources: fonts come from the kit, images go next to the design; scripts only from the kit's allowedScriptOrigins.")),
};
