import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireConfig, type ServerContext } from "../context.js";
import { openContractFolder } from "../design.js";
import { contractBrief, namedDependencies, readScreenContract, CONTRACT_FILE } from "../exporter.js";
import { guarded, Timings, toolResult } from "../result.js";
import { designArg } from "./lint.js";

export function registerBrief(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_brief", {
    title: "Brief for the design tool",
    description:
      `Turns the screen's ${CONTRACT_FILE} into the Markdown brief a design tool takes as its prompt: the exact inventory of ` +
      "values with real samples, actions, states, lists, texts, removed items and named dependencies. Show it to the user before " +
      "anything is designed: the screen folder needs no design page yet. An absent or invalid contract returns an error with the problems.",
    inputSchema: { screen: designArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ screen }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      // the folder, not a design page: the brief comes before anything is designed
      const folder = await t.async("resolve", () => openContractFolder(screen, cfg.designRoot));
      try {
        const load = readScreenContract(folder.dir);
        if (load.state !== "valid") {
          const lines = load.state === "absent" ? [`no ${CONTRACT_FILE} in ${screen}`] : load.problems.map((p) => `${CONTRACT_FILE}: ${p}`);
          lines.push(`fix: write ${CONTRACT_FILE} from the project (see design_ui_rules, "Screen contract")`);
          return toolResult(lines.join("\n"), { screen, contract: load.state, problems: load.state === "invalid" ? load.problems : [], timings: t.done() }, true);
        }
        const { kit } = t.sync("kit", () => ctx.runtime.kit(cfg.kitDir));
        const brief = contractBrief(load.contract, kit);
        return toolResult(brief, { screen: load.contract.screen, contract: "valid", brief, dependencies: namedDependencies(load.contract), timings: t.done() });
      } finally {
        folder.cleanup();
      }
    });
  });
}
