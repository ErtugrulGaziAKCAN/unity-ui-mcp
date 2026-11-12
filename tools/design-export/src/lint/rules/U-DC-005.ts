import { dcRule } from "./dc.js";

export const rule = dcRule("U-DC-005", ["outside-x-dc", "no-x-dc"], (d) => (d.kind === "no-x-dc" ? d.detail : `content outside <x-dc>: ${d.detail}`),
  "Put the whole artboard (markup and <helmet> styles) inside the one <x-dc> element.");
