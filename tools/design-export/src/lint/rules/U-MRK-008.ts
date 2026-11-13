import { argProblems } from "../text-runs.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/**
 * Smart String arguments (spec §13): a variable inside localized text is a `<span data-u-arg="name">sample</span>` and
 * data-en writes it as `{name}`; each placeholder has exactly one span and each span one placeholder (data-l10n-args,
 * when present, lists the same names).
 */
export const rule: Rule = {
  id: "U-MRK-008", severity: "error",
  check(s) {
    return Array.from(argProblems(s), ([path, list]) => make(rule, path, list.join("; "),
      'Mark each variable of a localized text with <span data-u-arg="name">sample</span> inside the element with data-l10n, and write it as {name} in data-en (once each); data-l10n-args is optional and must list the same names.'));
  },
};
