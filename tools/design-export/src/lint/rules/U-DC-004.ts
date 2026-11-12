import { dcRule } from "./dc.js";

export const rule = dcRule("U-DC-004", ["data-props"], (d) => `data-props entry ${d.detail}`,
  "Remove the prop and write its value into the markup (data-u-bind for a runtime value); keep only $preview.");
