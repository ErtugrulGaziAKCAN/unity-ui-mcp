import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireConfig, type ServerContext } from "../context.js";
import { guarded, Timings, toolResult } from "../result.js";
import { runUnity, UnityRunnerError } from "../runner.js";

export function registerKitSync(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_kit_sync", {
    title: "Sync the design kit from Unity",
    description:
      "Re-syncs fonts and settings from the Unity project into the design kit (kitDir) and regenerates the UI Toolkit font " +
      "twins, through the Unity runner (the open Editor's bridge by default). Run it after font or TMP settings changes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      let run;
      try {
        run = await t.async("unity", () => runUnity(cfg, "kitSync", {}, ctx.runnerOptions));
      } catch (e) {
        if (!(e instanceof UnityRunnerError)) throw e;
        return toolResult(`Kit sync not run: ${e.message}`, { kitDir: cfg.kitDir, timings: t.done() }, true);
      }
      ctx.runtime.invalidateKits();
      const data = { kitDir: cfg.kitDir, via: run.via, code: run.code, logTail: run.logTail, unityTimings: run.timings, timings: t.done() };
      if (run.code === 2) return toolResult(`Unity answered (code 2, via ${run.via}): ${run.logTail}`, data, true);
      if (run.code !== 0) return toolResult(`Kit sync failed (exit ${run.code}, via ${run.via}). Log tail:\n${run.logTail}`, data, true);
      return toolResult(`Kit synced into ${cfg.kitDir} via ${run.via}.${run.logTail ? `\n${run.logTail}` : ""}`, data);
    });
  });
}
