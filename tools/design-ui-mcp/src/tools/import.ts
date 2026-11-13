import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, type ServerContext } from "../context.js";
import { findEntry, resolveScreen, sha256, sourceSha } from "../design.js";
import { MISSING } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { runUnity, UnityRunnerError } from "../runner.js";
import { exportDirOf, readLastImport, unityDirOf, writeLastImport } from "../status.js";
import { designArg, formatFindings } from "./lint.js";

export function registerImport(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_import", {
    title: "Import a design into Unity",
    description:
      "Exports one screen folder under designRoot (lint, browser capture, IR, goldens) and compiles it into the Unity project " +
      "through the Unity runner (the open Editor's bridge, or the configured command). Skips the export when the design and " +
      "kit are unchanged and the Unity call when the IR is unchanged. Records <screen>/.design-ui/last-import.json. " +
      "Generated Unity files are never edited by hand; an import refuses to overwrite hand edits unless discardManualEdits is true.",
    inputSchema: {
      design: designArg,
      discardManualEdits: z.boolean().optional().describe("Overwrite generated Unity files that were edited by hand (default false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ design, discardManualEdits }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const { screen, dir } = resolveScreen(design, cfg.designRoot);
      const entry = findEntry(dir);
      const exportScreen = ctx.pipeline.exportScreen;
      if (!exportScreen) {
        return toolResult(
          `design_ui_import is not available yet: ${MISSING.export}. Also, ${MISSING.compile}. ` +
          `Nothing was exported and Unity was not called. design_ui_lint works now and shows whether ${screen} is ready.`,
          { screen, available: false, missing: ["export", "unity-import"], timings: t.done() }, true);
      }

      const kit = t.sync("kit", () => ctx.runtime.kit(cfg.kitDir));
      const src = t.sync("hash", () => sourceSha(dir));
      const last = readLastImport(dir);
      const exportDir = exportDirOf(dir);
      const irFile = path.join(exportDir, "screen.ir.json");

      // one skip decision: the exporter's (design, kit and tool hashes); an unchanged export is reused as it is
      // the browser is only acquired when the exporter actually exports
      const out = await t.async("export", () => exportScreen(entry, kit.kit, exportDir, () => ctx.runtime.browser()));
      if (!out.ok) {
        const errors = out.findings.filter((f) => f.severity === "error");
        return toolResult([
          `Import stopped: lint found ${errors.length} error${errors.length === 1 ? "" : "s"} in ${screen}. Fix these in the design` +
          ` (the previous export and last import are untouched):`,
          ...formatFindings(out.findings),
        ].join("\n"), { screen, exported: false, unityCalled: false, findings: out.findings, timings: t.done() }, true);
      }
      const exported = !out.skipped;
      if (!fs.existsSync(irFile)) throw new Error(`the export of ${screen} wrote no screen.ir.json in ${exportDir}`);
      const irSha = sha256(fs.readFileSync(irFile));

      const discard = discardManualEdits === true;
      if (last && last.irSha === irSha && !discard) {
        if (exported || last.sourceSha !== src || last.kitSha !== kit.sha) writeLastImport(dir, { ...last, sourceSha: src, kitSha: kit.sha });
        return toolResult(`${screen} is unchanged since the last import (${last.importedAt}); Unity was not called.`, {
          screen, exported, unityCalled: false, via: last.via, irSha, sourceSha: src, exportDir, timings: t.done(),
        });
      }

      let run;
      try {
        run = await t.async("unity", () => runUnity(cfg, "import", { exportDir, outDir: unityDirOf(dir), discardManualEdits: String(discard) }, ctx.runnerOptions));
      } catch (e) {
        if (!(e instanceof UnityRunnerError)) throw e;
        return toolResult(`Import of ${screen} not run: ${e.message}`, { screen, exported, unityCalled: false, exportDir, timings: t.done() }, true);
      }
      if (run.code !== 0) {
        const head = run.code === 2
          ? `Unity cannot import ${screen} yet (code 2, via ${run.via}): ${run.logTail}`
          : `Unity import of ${screen} failed (exit ${run.code}, via ${run.via}). Log tail:\n${run.logTail}`;
        return toolResult(head, {
          screen, exported, unityCalled: true, via: run.via, code: run.code, logTail: run.logTail, exportDir, unityTimings: run.timings, timings: t.done(),
        }, true);
      }

      const steps: Record<string, number> = { export: t.steps.export };
      if (run.via === "editor") { steps.import = run.timings.request; if (run.timings.compileWait !== undefined) steps.compile = run.timings.compileWait; }
      else steps.import = run.timings.total;
      writeLastImport(dir, {
        screen, sourceSha: src, kitSha: kit.sha, irSha, importedAt: new Date().toISOString(), via: run.via, discardManualEdits: discard, timings: steps,
      });
      return toolResult(`Imported ${screen} into Unity via ${run.via}${exported ? "" : " (export reused: design and kit unchanged)"}. Next: design_ui_verify { screen: "${screen}" }.`, {
        screen, exported, unityCalled: true, via: run.via, code: 0, irSha, sourceSha: src, exportDir, logTail: run.logTail,
        unityTimings: run.timings, timings: t.done(),
      });
    });
  });
}
