import { CONTRACT_FILE } from "../../contract.js";
import type { Rule } from "../types.js";
import { make } from "./util.js";

/**
 * No screen contract beside the design while the kit's screenContract is optional (spec 2026-11-16-screen-contract §4):
 * the design is not checked against what the game has for the screen. Under required, U-CON-001 reports it as an error.
 */
export const rule: Rule = {
  id: "I-CON-001", severity: "info",
  check(_s, kit, _b, ctx) {
    if (ctx.contract?.state !== "absent" || kit.screenContract === "required") return [];
    return [make(rule, "document", `no ${CONTRACT_FILE} beside the design: it is not checked against what the game has for this screen`,
      `Write ${CONTRACT_FILE} from the project (every value with its source and real samples, every action with its handler, every state, list and text) to have the design checked against the game.`)];
  },
};
