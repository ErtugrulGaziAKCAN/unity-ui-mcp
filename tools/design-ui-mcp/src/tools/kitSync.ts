import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireConfig, withProgress, type ServerContext } from "../context.js";
import { cloneKitMessage, isCloneKit } from "../kit-location.js";
import { guarded, Timings, toolResult } from "../result.js";
import { runUnity, UnityRunnerError, withIssues } from "../runner.js";

export function registerKitSync(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_kit_sync", {
    title: "Sync the design kit from Unity",
    description:
      "Re-syncs fonts and settings from the Unity project into the design kit (kitDir) and regenerates the UI Toolkit font " +
      "twins, through the Unity runner (the open Editor's bridge by default). Run it after font or TMP settings changes.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, // rewrites the kit's font files
  }, async (extra) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      if (isCloneKit(cfg.kitDir)) {
        return toolResult(`Kit sync not run: ${cloneKitMessage(cfg.kitDir, cfg.designRoot, cfg.configPath)}.`, { kitDir: cfg.kitDir, timings: t.done() }, true);
      }
      let run;
      try {
        run = await t.async("unity", () => runUnity(cfg, "kitSync", {}, withProgress(ctx, extra)));
      } catch (e) {
        if (!(e instanceof UnityRunnerError)) throw e;
        return toolResult(`Kit sync not run: ${e.message}`, { kitDir: cfg.kitDir, timings: t.done() }, true);
      }
      ctx.runtime.invalidateKits();
      const data = {
        kitDir: cfg.kitDir, via: run.via, code: run.code, warnings: run.warnings, errors: run.errors, logTail: run.logTail,
        unityTimings: run.timings, timings: t.done(),
      };
      // Unity's errors and warnings first: the log tail keeps only the end of a long log (the font twin list fills it)
      if (run.code === 2) return toolResult(withIssues(`Unity answered (code 2, via ${run.via}).`, run), data, true);
      if (run.code !== 0) return toolResult(withIssues(`Kit sync failed (exit ${run.code}, via ${run.via}).`, run), data, true);
      return toolResult(withIssues(`Kit synced into ${cfg.kitDir} via ${run.via}.`, run), data);
    });
  });
}
