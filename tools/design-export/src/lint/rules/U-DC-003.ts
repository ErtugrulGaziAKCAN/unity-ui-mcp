import { dcRule } from "./dc.js";

export const rule = dcRule("U-DC-003", ["script-ui"], (d) => `the Design Component script builds UI (${d.detail})`,
  "Write the UI as static markup inside <x-dc>; the DC script must not create or insert elements.");
