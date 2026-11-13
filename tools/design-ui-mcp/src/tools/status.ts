import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeBridge, type BridgeStatus } from "../bridge.js";
import type { ServerContext } from "../context.js";
import { requireConfig } from "../context.js";
import { findEntry, resolveScreen } from "../design.js";
import { MISSING, unityStep } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { exportDirOf, readLastImport, readLastVerify, screenStatus } from "../status.js";
import { VERSION } from "../version.js";

/** `needsEditor`: live only while the open Unity Editor's bridge answers (`available` is the last probe's answer). */
export interface ToolAvailability { available: boolean; note: string; needsEditor?: boolean }

/**
 * What each tool can do in this build; shared by design_ui_status and the server instructions. `bridge` is a probe of
 * the Editor bridge (probeBridge); without one (the instructions, written once at start) a step on the Editor route is
 * described as live while the bridge answers.
 */
export function availability(ctx: ServerContext, bridge?: BridgeStatus | null): Record<string, ToolAvailability> {
  const exp = !!ctx.pipeline.exportScreen, cmp = !!ctx.pipeline.compareScreen, cap = !!ctx.pipeline.unityCapture;
  const compile = unityStep(ctx.cfg, "import", bridge), capture = unityStep(ctx.cfg, "capture", bridge), kit = unityStep(ctx.cfg, "kitSync", bridge);
  const unprobed = (r: { needsEditor?: boolean }) => !!r.needsEditor && !bridge;
  const whileEditor = "while the Unity Editor bridge answers (design_ui_status shows whether it answers)";
  return {
    design_ui_rules: { available: true, note: "live (kit RULES.md is still a stub; allowed CSS, attributes, text styles and the lint rule table are complete)" },
    design_ui_list: { available: true, note: "live" },
    design_ui_lint: { available: true, note: "live (real lint in Chromium with the kit fonts)" },
    design_ui_status: { available: true, note: "live" },
    design_ui_import: !exp
      ? { available: false, note: `not available yet: ${MISSING.export}; ${MISSING.compile}` }
      : unprobed(compile)
        ? { available: false, needsEditor: true, note: `live ${whileEditor}: export (lint, IR, goldens, assets), then the Unity compile ${compile.how}` }
        : compile.ready
          ? { available: true, needsEditor: compile.needsEditor, note: `live: export (lint, IR, goldens, assets), then the Unity compile ${compile.how}` }
          : compile.needsEditor
            ? { available: false, needsEditor: true, note: `${compile.how}; the export is live, the Unity compile needs the open Unity Editor with the com.unity.design-ui bridge` }
            : { available: false, note: `the export is live, but the Unity compile cannot run: ${compile.how}` },
    design_ui_verify: !cmp
      ? { available: false, note: `not available yet: ${MISSING.compare}` }
      : !cap
        ? { available: false, note: `not available yet: ${MISSING.capture}` }
        : capture.ready
          ? { available: true, note: `live: Unity capture ${capture.how} (counted only with capture-done.json), then the comparison and report.html` }
          : { available: false, note: `the comparison is live, but the Unity capture cannot run: ${capture.how}` },
    design_ui_kit_sync: unprobed(kit)
      ? { available: false, needsEditor: true, note: `live ${whileEditor}: ${kit.how}` }
      : kit.ready
        ? { available: true, needsEditor: kit.needsEditor, note: `live: ${kit.how}` }
        : kit.needsEditor
          ? { available: false, needsEditor: true, note: `${kit.how}; kit sync needs the open Unity Editor with the com.unity.design-ui bridge` }
          : { available: false, note: `the Unity kit sync cannot run: ${kit.how}` },
  };
}

export function registerStatus(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_status", {
    title: "Status",
    description:
      "Without a screen: what this server version supports, its configuration and the Unity bridge. With a screen: its " +
      "hashes, last import, last verdict and report.",
    inputSchema: { screen: z.string().min(1).optional().describe("Screen id (folder name under designRoot) or the screen folder's path.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ screen }) => {
    const t = new Timings();
    return guarded(t, async () => {
      if (screen !== undefined) {
        const cfg = requireConfig(ctx);
        const { screen: id, dir } = resolveScreen(screen, cfg.designRoot);
        const s = t.sync("hash", () => screenStatus(cfg, dir));
        let entry: string | null = null;
        try { entry = path.relative(dir, findEntry(dir)); } catch { /* reported by list */ }
        const lastImport = readLastImport(dir), lastVerify = readLastVerify(dir);
        const data = {
          screen: id, folder: dir, entry, ...s, lastImport, lastVerify, exportDir: exportDirOf(dir),
          manualEdits: null, pendingTranslations: null,
          note: "manual edits and pending translations are reported by the Unity package's import pipeline (not available in this version)",
          timings: t.done(),
        };
        const lines = [
          `${id}: ${s.state}`,
          `source sha ${s.sourceSha.slice(0, 12)}${lastImport ? `, last import ${lastImport.importedAt} via ${lastImport.via}` : ", never imported"}`,
          s.verdict ? `last verdict: ${s.verdict} (${s.reportPath ?? "report missing"})` : "no verdict",
        ];
        return toolResult(lines.join("\n"), data);
      }

      const cfg = ctx.cfg;
      const unity = cfg ? await t.async("bridge", () => probeBridge(cfg.projectDir)) : null;
      const tools = availability(ctx, unity);
      const config = cfg
        ? {
          ok: true, path: cfg.configPath, designRoot: cfg.designRoot, designRootExists: fs.existsSync(cfg.designRoot),
          kitDir: cfg.kitDir, kitFound: fs.existsSync(path.join(cfg.kitDir, "kit.config.json")), profileAsset: cfg.profileAsset,
          prefer: cfg.unityRunner.prefer, captureVia: cfg.unityRunner.captureVia,
        }
        : { ok: false, error: ctx.configError };
      const lines = [
        `design-ui MCP server ${VERSION} for ${ctx.projectDir}`,
        cfg ? `config: ${cfg.configPath} (designRoot ${cfg.designRoot}, Unity runner ${cfg.unityRunner.prefer})` : `config problem: ${ctx.configError}`,
        ...(unity ? [`Unity bridge: ${unity.bridge} — ${unity.detail}`] : []),
        `browser: ${ctx.runtime.browserWarm ? "warm" : "not started (starts on the first lint)"}`,
        "tools:",
        ...Object.entries(tools).map(([name, a]) => `- ${name}: ${a.note}`),
      ];
      return toolResult(lines.join("\n"), {
        server: "design-ui", version: VERSION, project: ctx.projectDir, config, tools,
        pipeline: { export: !!ctx.pipeline.exportScreen, compare: !!ctx.pipeline.compareScreen, capture: !!ctx.pipeline.unityCapture },
        unity, browser: { warm: ctx.runtime.browserWarm, launches: ctx.runtime.browserLaunches }, timings: t.done(),
      });
    });
  });
}
