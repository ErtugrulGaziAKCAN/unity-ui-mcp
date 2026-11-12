import { dcRule } from "./dc.js";

export const rule = dcRule("U-DC-002", ["sc-for", "sc-if", "dc-import", "x-import"], (d) => `${d.kind}: ${d.detail}`,
  "Write the rows out as static markup with data-u-repeat on the first; show variants as data-u-state roots instead of sc-if; inline imported components.");
