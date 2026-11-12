import { dcRule } from "./dc.js";

export const rule = dcRule("U-DC-001", ["hole"], (d) => `template hole ${d.detail}`,
  "Replace the {{…}} hole with its sample text; mark runtime values with data-u-bind and static copy with data-l10n/data-en.");
