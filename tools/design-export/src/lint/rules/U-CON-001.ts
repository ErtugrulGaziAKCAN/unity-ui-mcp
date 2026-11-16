import { CONTRACT_FILE } from "../../contract.js";
import { screenId } from "../contract-scan.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

const FIX = `Write or repair ${CONTRACT_FILE} beside the design from the project: "contract": 1, the design's screen id, ` +
  "the kind (update with what it replaces, or new), and one entry per value, action, state, repeat and text key, each existing " +
  "one with its source, handler or when, each requested one with the user's note.";

/**
 * The screen contract cannot be checked against: missing while the kit requires one, not valid JSON or not in the
 * contract format (every problem listed), or written for another screen than the design's data-u-screen.
 */
export const rule: Rule = {
  id: "U-CON-001", severity: "error",
  check(s, kit, _b, ctx) {
    const c = ctx.contract;
    if (c === null) return [];
    if (c.state === "absent") {
      return kit.screenContract === "required"
        ? [make(rule, "document", `no ${CONTRACT_FILE} beside the design, and the kit requires one (screenContract: required)`, FIX)]
        : [];
    }
    if (c.state === "invalid") return [make(rule, "document", `the screen contract is not valid: ${c.problems.join("; ")}`, FIX)];
    const screen = screenId(s);
    if (screen !== undefined && screen !== c.contract.screen)
      return [make(rule, "document", `${CONTRACT_FILE} is for screen "${c.contract.screen}", but the design's data-u-screen is "${screen}"`, FIX)];
    return [];
  },
};
