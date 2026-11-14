import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { probeBridge } from "../bridge.js";
import { requireConfig, type ServerContext } from "../context.js";
import { guarded, Timings, toolResult } from "../result.js";
import { listScreens } from "../status.js";

export function registerList(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_list", {
    title: "List screens",
    description:
      "Lists the design screens under designRoot (one folder per screen; screen = the data-u-screen its pages name, folder = its " +
      "folder) with their state: new, design-changed (since the " +
      "last import), imported, verified or failed; and whether the Unity Editor bridge of this project is connected " +
      "(unity.bridge: connected, not-found, not-responding or unauthorized).",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const designRootExists = fs.existsSync(cfg.designRoot);
      const screens = t.sync("screens", () => listScreens(cfg));
      const unity = await t.async("bridge", () => probeBridge(cfg.projectDir));
      const lines = [
        designRootExists
          ? `${screens.length} screen${screens.length === 1 ? "" : "s"} under ${cfg.designRoot}${screens.length ? ":" : " (put each design in its own folder there)."}`
          : `designRoot ${cfg.designRoot} does not exist yet: create it and put each design in its own folder (<designRoot>/<screen-id>/).`,
        ...screens.map((s) => `- ${s.screen}: ${s.state}${s.verdict ? ` (${s.verdict})` : ""}${s.entry ? ` [${s.entry}]` : ""}${s.problem ? ` — ${s.problem}` : ""}`),
        `Unity bridge: ${unity.bridge} — ${unity.detail}`,
      ];
      return toolResult(lines.join("\n"), {
        project: cfg.projectDir, designRoot: cfg.designRoot, designRootExists, screens, unity, timings: t.done(),
      });
    });
  });
}
