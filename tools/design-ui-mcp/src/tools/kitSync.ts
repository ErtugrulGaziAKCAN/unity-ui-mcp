import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, withProgress, type ServerContext } from "../context.js";
import { cloneKitMessage, isCloneKit } from "../kit-location.js";
import { guarded, Timings, toolResult } from "../result.js";
import { runUnity, UnityRunnerError, withIssues } from "../runner.js";

/** How the Unity side's refusal to drop a viewport the kit declares and the profile lacks starts (KitSync.MissingViewportsPrefix). */
export const MISSING_VIEWPORTS = "kit viewports missing from the profile:";

export function registerKitSync(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_kit_sync", {
    title: "Sync the design kit from Unity",
    description:
      "Re-syncs fonts and settings from the Unity project into the design kit (kitDir) and regenerates the UI Toolkit font " +
      "twins, through the Unity runner (the open Editor's bridge by default). Run it after font or TMP settings changes. It " +
      "refuses to drop a viewport kit.config.json declares and the DesignUiProfile lacks (a profile saved before the six default " +
      "viewports): call it again with addProfileViewports to add the kit's viewports to the profile, after the user agrees.",
    inputSchema: {
      addProfileViewports: z.boolean().optional().describe(
        "Add the viewports kit.config.json declares and the DesignUiProfile lacks to the profile (with their class; the profile asset is saved, " +
        "and Edit > Undo in Unity restores the open profile until the project is saved again) before syncing, instead of refusing (default false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, // rewrites the kit's font files
  }, async (args, extra) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      if (isCloneKit(cfg.kitDir)) {
        return toolResult(`Kit sync not run: ${cloneKitMessage(cfg.kitDir, cfg.designRoot, cfg.configPath)}.`, { kitDir: cfg.kitDir, timings: t.done() }, true);
      }
      let run;
      try {
        run = await t.async("unity", () => runUnity(cfg, "kitSync", { addProfileViewports: args.addProfileViewports ? "true" : "false" }, withProgress(ctx, extra)));
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
      if (run.code !== 0) {
        // the refusal to drop the kit's viewports: say how to add them to the profile, before the log tail
        const viewports = (run.errors ?? []).some((e) => e.startsWith(MISSING_VIEWPORTS))
          ? [`To add the kit's viewports to the profile: design_ui_kit_sync with addProfileViewports: true (or in Unity: Window > Design UI > ` +
            `Add Default Viewports to Profile). If the game does not ship those resolutions, remove them from kit.config.json's viewports instead.`]
          : [];
        const text = [withIssues(`Kit sync failed (exit ${run.code}, via ${run.via}).`, run, false), ...viewports, ...(run.logTail ? [`Log tail:\n${run.logTail}`] : [])];
        return toolResult(text.join("\n"), data, true);
      }
      return toolResult(withIssues(`Kit synced into ${cfg.kitDir} via ${run.via}.`, run), data);
    });
  });
}
