import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, type ServerContext } from "../context.js";
import { resolveScreen, sourceSha } from "../design.js";
import { MISSING } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { runUnity, UnityRunnerError } from "../runner.js";
import { exportDirOf, readLastImport, reportPathOf, unityDirOf, writeLastVerify } from "../status.js";

export function registerVerify(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_verify", {
    title: "Verify a screen in Unity",
    description:
      "Captures an imported screen in Unity (isolated batch run by default, never the open Editor's Play mode), compares it " +
      "with the design's goldens and returns the verdict, the report path (<screen>/report.html) and the top issues. A " +
      "capture that cannot run gives no verdict; only this tool's verdict counts as a pass.",
    inputSchema: { screen: z.string().min(1).describe("Screen id (folder name under designRoot) or the screen folder's path.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ screen: screenArg }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const { screen, dir } = resolveScreen(screenArg, cfg.designRoot);
      const compareScreen = ctx.pipeline.compareScreen;
      if (!compareScreen) {
        return toolResult(`design_ui_verify is not available yet: ${MISSING.compare}. No capture ran and no verdict exists for ${screen}.`, {
          screen, available: false, missing: ["capture", "compare"], verdict: null, timings: t.done(),
        }, true);
      }
      if (!ctx.pipeline.unityCapture) {
        return toolResult(`design_ui_verify is not available yet: ${MISSING.capture}. No capture ran and no verdict exists for ${screen}.`, {
          screen, available: false, missing: ["capture"], verdict: null, timings: t.done(),
        }, true);
      }
      const imp = readLastImport(dir);
      if (!imp) {
        return toolResult(`${screen} has not been imported yet: run design_ui_import { design: "${screen}" } first.`, { screen, verdict: null, timings: t.done() }, true);
      }
      if (imp.sourceSha !== t.sync("hash", () => sourceSha(dir))) {
        return toolResult(`The design of ${screen} changed since the last import (${imp.importedAt}): run design_ui_import first.`, { screen, verdict: null, timings: t.done() }, true);
      }

      const exportDir = exportDirOf(dir), unityDir = unityDirOf(dir), reportPath = reportPathOf(dir);
      // the capture goes to a fresh staging folder: captures left from an earlier run are never compared, and the
      // previous report, its captures and last-verify.json stay as they are until there is a new verdict
      const staging = `${unityDir}.next`;
      const dropStaging = () => fs.rmSync(staging, { recursive: true, force: true });
      dropStaging();
      let run;
      try {
        run = await t.async("capture", () => runUnity(cfg, "capture", { exportDir, outDir: staging }, ctx.runnerOptions));
      } catch (e) {
        dropStaging();
        if (!(e instanceof UnityRunnerError)) throw e;
        return toolResult(`Verify of ${screen} not run: ${e.message}. No verdict.`, { screen, verdict: null, timings: t.done() }, true);
      }
      if (run.code !== 0) {
        dropStaging();
        return toolResult(`Unity capture of ${screen} failed (exit ${run.code}, via ${run.via}); no verdict. Log tail:\n${run.logTail}`, {
          screen, verdict: null, code: run.code, logTail: run.logTail, timings: t.done(),
        }, true);
      }
      const steps: Record<string, number> = { ...(imp.timings ?? {}), capture: t.steps.capture };
      const v = await t.async("compare", () => compareScreen(exportDir, staging, reportPath, { timings: steps, unityDir }));
      if (v.compared === 0) {
        const none = !fs.existsSync(path.join(staging, "boxes.json"));
        v.discard?.();
        dropStaging();
        return toolResult(`Unity capture of ${screen} (via ${run.via}) ${none ? "wrote no boxes.json" : "produced none of the design's captures"}; no verdict. ` +
          "The previous report and verdict are unchanged.", { screen, verdict: null, notRun: v.notRun, logTail: run.logTail, timings: t.done() }, true);
      }
      const verdict = v.pass && v.notRun.length === 0 ? "pass" : "fail";
      // the report and last-verify.json are written together, only now that the verdict is decided
      if (v.publish) v.publish(); else dropStaging();
      writeLastVerify(dir, {
        screen, sourceSha: imp.sourceSha, irSha: imp.irSha, verdict, reportPath, verifiedAt: new Date().toISOString(),
        topIssues: v.topIssues, notRun: v.notRun,
      });
      const lines = [
        `${verdict.toUpperCase()}: ${screen} (report: ${reportPath})`,
        ...v.topIssues.slice(0, 10).map((i) => `- ${i}`),
        ...(v.notRun.length ? [`Not run: ${v.notRun.join(", ")}`] : []),
        ...(v.extra?.length ? [`Extra Unity captures (not compared): ${v.extra.join(", ")}`] : []),
        ...(v.warnings ?? []).map((w) => `Warning: ${w}`),
        ...(v.notSampled ? [`Backgrounds not sampled (every point covered or on text): ${v.notSampled}`] : []),
      ];
      return toolResult(lines.join("\n"), {
        screen, verdict, reportPath, verdictFile: v.verdictFile ?? null, compared: v.compared ?? null, topIssues: v.topIssues, notRun: v.notRun,
        extra: v.extra ?? [], warnings: v.warnings ?? [], notSampled: v.notSampled ?? 0, steps: v.timings ?? steps, timings: t.done(),
      }, verdict !== "pass");
    });
  });
}
