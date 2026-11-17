import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, withProgress, type ServerContext } from "../context.js";
import { designPath, exportedPage, resolveScreen, sha256, sourceSha } from "../design.js";
import { BOXES_FILE, classLines, LEGACY_BOXES_FILE, toolHash } from "../exporter.js";
import { MISSING, unityStep } from "../pipeline.js";
import { bytesOf, FAILED_RUNS_KEPT as KEPT, mb } from "../cache.js";
import { guarded, Timings, toolResult } from "../result.js";
import { afterRun, whileBusy } from "./clean.js";
import { runUnity, UnityRunnerError } from "../runner.js";
import { exportDirOf, importedEntry, readLastImport, reportPathOf, unityDirOf, writeLastVerify } from "../status.js";
import { SCREEN_ARG } from "./status.js";

export function registerVerify(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_verify", {
    title: "Verify a screen in Unity",
    description:
      "Captures an imported screen in Unity (isolated batch run by default, never the open Editor's Play mode), compares it " +
      "with the design's goldens and returns the verdict, the report path (<screen>/report.html) and the top issues. A " +
      "capture that cannot run gives no verdict; only this tool's verdict counts as a pass. A page path verifies that page " +
      "only when it is the screen folder's last import. keepCaptures keeps the run's Unity captures in the screen's bookkeeping " +
      "(<screen>/.design-ui/kept-captures) to compare again offline, with the screen's export beside them; the next verify that gives a " +
      "verdict, an import that exports the screen again, a later cleanup over the budget or design_ui_clean removes them.",
    inputSchema: {
      screen: z.string().min(1).describe(SCREEN_ARG),
      keepCaptures: z.boolean().optional().describe(
        "Keep this run's Unity captures (PNGs, boxes.jsonl, boxes.meta.json) in <screen>/.design-ui/kept-captures once the verdict is " +
        "written, for an offline comparison (design-export compare <export> --unity <kept-captures> --report <file>), instead of " +
        "deleting them (default false). They count toward cacheBudgetMB; the next verify that gives a verdict, an import that exports the " +
        "screen again, a later cleanup over the budget and design_ui_clean remove them."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ screen: screenArg, keepCaptures }, extra) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const ref = resolveScreen(screenArg, cfg.designRoot);
      return afterRun(cfg, await whileBusy(ref.dir, "verify", async () => {
        const { dir } = ref;
        let screen = ref.screen;
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
        const route = unityStep(cfg, "capture");
        if (!route.ready) {
          return toolResult(`design_ui_verify cannot capture: ${route.how}. No capture ran and no verdict exists for ${screen}.`, {
            screen, available: false, missing: ["capture"], verdict: null, timings: t.done(),
          }, true);
        }
        const imp = readLastImport(dir);
        const page = ref.entry ? designPath(ref.entry, cfg.designRoot) : null;
        if (!imp) {
          return toolResult(`${page ?? screen} has not been imported yet: run design_ui_import { design: "${page ?? screen}" } first.`, { screen, verdict: null, timings: t.done() }, true);
        }
        // the folder keeps one import: a page verifies only when it is that import (another page's goldens are not its own)
        const entry = importedEntry(dir, imp);
        if (ref.entry && entry !== path.relative(dir, ref.entry)) {
          return toolResult(`${page} is not the last import of its screen folder (${entry ?? "a page this version cannot name"}, ${imp.importedAt}): ` +
            `run design_ui_import { design: "${page}" } first, then verify it. No capture ran.`, { screen, entry: path.relative(dir, ref.entry), verdict: null, timings: t.done() }, true);
        }
        screen = imp.screen;
        if (imp.sourceSha !== t.sync("hash", () => sourceSha(dir))) {
          return toolResult(`The design of ${screen} changed since the last import (${imp.importedAt}): run design_ui_import first.`, { screen, verdict: null, timings: t.done() }, true);
        }

        const exportDir = exportDirOf(dir), unityDir = unityDirOf(dir), reportPath = reportPathOf(dir);
        // the export must be the recorded import's: a later import exports before Unity runs, and when its Unity step does not
        // finish the folder's export holds that other page while the record still names this one
        // an export the cleanup removed (over the cache budget) is exported again from the imported page; it must give the
        // recorded IR, else the import is out of date
        const irFile = path.join(exportDir, "screen.ir.json");
        let reexported = false;
        if (!fs.existsSync(irFile) && entry && ctx.pipeline.exportScreen) {
          const kit = t.sync("kit", () => ctx.runtime.kit(cfg.kitDir));
          const out = await t.async("export", () => ctx.pipeline.exportScreen!(path.join(dir, entry), kit.kit, exportDir, () => ctx.runtime.browser()));
          reexported = out.ok;
        }
        const exported = fs.existsSync(irFile) ? fs.readFileSync(irFile) : null;
        if (!exported || sha256(exported) !== imp.irSha) {
          const held = exported ? exportedPage(exported) : null;
          const again = entry ? designPath(path.join(dir, entry), cfg.designRoot) : screen;
          return toolResult(`${page ?? screen} cannot be verified: the export ${reexported ? "made again (the cleanup had removed it) " : ""}holds ${held ? designPath(path.join(dir, held), cfg.designRoot) : exported ? "another export" : "nothing"}; ` +
            `import ${again} again first (its import of ${imp.importedAt} is recorded, but the export changed since). No capture ran.`,
          { screen, entry, verdict: null, timings: t.done() }, true);
        }
        // an export another version of the exporter made: its goldens may lack records this comparison reads (an export made
        // before the ellipsis records was judged without the ellipsis checks), so a verdict on it could pass what it cannot see
        const staleExport = exportOfOtherTool(exportDir);
        if (staleExport) {
          const again = entry ? designPath(path.join(dir, entry), cfg.designRoot) : screen;
          return toolResult(`${page ?? screen} cannot be verified: ${staleExport}. Run design_ui_import { design: "${again}" } (it exports the screen ` +
            `again), then verify. No capture ran; the previous verdict is unchanged.`, { screen, entry, verdict: null, timings: t.done() }, true);
        }
        // the capture goes to a fresh staging folder: captures left from an earlier run are never compared, and the
        // previous report, its captures and last-verify.json stay as they are until there is a new verdict
        const staging = `${unityDir}.next`;
        const dropStaging = () => fs.rmSync(staging, { recursive: true, force: true });
        dropStaging();
        // a run without a verdict keeps what it captured and its log next to the result (failed-<run>), for diagnosis
        const keep = (reason: string, info: { code?: number; via?: string; log?: string }) =>
          keepFailedRun(path.dirname(unityDir), staging, { screen, entry, reason, code: info.code ?? null, via: info.via ?? null, log: info.log ?? "", timings: t.done() });
        const kept = (where: string) => ` Partial captures and logs kept in ${where}.`;
        let run;
        try {
          run = await t.async("capture", () => runUnity(cfg, "capture", { exportDir, outDir: staging }, withProgress(ctx, extra)));
        } catch (e) {
          if (!(e instanceof UnityRunnerError)) { dropStaging(); throw e; }
          const evidence = keep(e.message, { log: e.log });
          return toolResult(`Verify of ${screen} not run: ${e.message}. No verdict.${kept(evidence)}`, { screen, verdict: null, evidence, timings: t.done() }, true);
        }
        if (run.code !== 0) {
          const evidence = keep(`Unity capture failed (exit ${run.code}, via ${run.via})`, run);
          return toolResult(`Unity capture of ${screen} failed (exit ${run.code}, via ${run.via}); no verdict.${kept(evidence)} Log tail:\n${run.logTail}`, {
            screen, verdict: null, code: run.code, logTail: run.logTail, evidence, timings: t.done(),
          }, true);
        }
        // only a capture that wrote its done marker last counts; anything else is an unfinished run
        if (!fs.existsSync(path.join(staging, "capture-done.json"))) {
          const evidence = keep("Unity capture did not finish (no capture-done.json)", run);
          return toolResult(`Unity capture of ${screen} (via ${run.via}) did not finish (no capture-done.json); no verdict. ` +
            `The previous report and verdict are unchanged.${kept(evidence)}`, { screen, verdict: null, logTail: run.logTail, evidence, timings: t.done() }, true);
        }
        const steps: Record<string, number> = { ...(imp.timings ?? {}), capture: t.steps.capture };
        let v;
        try {
          v = await t.async("compare", () => compareScreen(exportDir, staging, reportPath, { timings: steps, unityDir, keepCaptures: keepCaptures === true }));
        } catch (e) {
          const evidence = keep(`the comparison failed: ${(e as Error).message}`, run); // e.g. an unreadable boxes.jsonl
          return toolResult(`Comparison of ${screen} failed: ${(e as Error).message}; no verdict.${kept(evidence)}`, { screen, verdict: null, evidence, timings: t.done() }, true);
        }
        if (v.compared === 0) {
          const unfinished = !fs.existsSync(path.join(staging, "capture-done.json"));
          const none = !unfinished && ![BOXES_FILE, LEGACY_BOXES_FILE].some((f) => fs.existsSync(path.join(staging, f)));
          v.discard?.();
          const what = unfinished ? "did not finish (no capture-done.json)" : none ? `wrote no ${BOXES_FILE}` : "produced none of the design's captures";
          const evidence = keep(`Unity capture ${what}`, run);
          return toolResult(`Unity capture of ${screen} (via ${run.via}) ${what}; no verdict. ` +
            `The previous report and verdict are unchanged.${kept(evidence)}`, { screen, verdict: null, notRun: v.notRun, logTail: run.logTail, evidence, timings: t.done() }, true);
        }
        // a job the design shows in no context, or one that did not run, was not compared: incomplete, never a pass
        const hidden = v.hidden ?? [];
        const verdict = v.status ?? (v.pass && v.notRun.length === 0 && hidden.length === 0 ? "pass" : "fail");
        // the report and last-verify.json are written together, only now that the verdict is decided
        if (v.publish) v.publish(); else dropStaging();
        // the captures kept on request (keepCaptures), for an offline comparison
        const keptDir = v.publish && v.keptCaptures && fs.existsSync(v.keptCaptures) ? v.keptCaptures : null;
        const keptRun = keptDir ? { dir: keptDir, bytes: bytesOf(keptDir) } : null;
        writeLastVerify(dir, {
          screen, ...(entry ? { entry } : {}), sourceSha: imp.sourceSha, irSha: imp.irSha, verdict, reportPath, verifiedAt: new Date().toISOString(),
          topIssues: v.topIssues, notRun: v.notRun, hidden, ...(keptRun ? { keptCaptures: keptRun.dir } : {}),
        });
        const lines = [
          `${verdict.toUpperCase()}: ${screen} (report: ${reportPath})`,
          ...classLines({ byClass: v.byClass ?? {} }).map((l) => `Viewports ${l}`),
          ...v.topIssues.slice(0, 10).map((i) => `- ${i}`),
          ...(v.notRun.length ? [`Not run: ${v.notRun.join(", ")}`] : []),
          ...(hidden.length ? [`Hidden in the design (no golden, not compared; show them in a state, class or repeat item, or remove their layers): ${hidden.join(", ")}`] : []),
          ...(v.extra?.length ? [`Extra Unity captures (not compared): ${v.extra.join(", ")}`] : []),
          ...(v.warnings ?? []).map((w) => `Warning: ${w}`),
          ...(v.colour?.space === "Linear" && v.colour.path !== "linear-panel"
            ? ["Colour: Linear colour space, captured through the gamma composite: in game this holds for panels rendered through DesignUiGammaComposite"] : []),
          ...(v.notSampled ? [`Backgrounds and pictures not sampled (every point covered or on text): ${v.notSampled}`] : []),
          ...(keptRun ? [`Unity captures kept in ${keptRun.dir} (${mb(keptRun.bytes)}; counted by cacheBudgetMB; removed by the next verify, an import that exports the screen again, a later cleanup over the budget or design_ui_clean). ` +
            `Compare them again offline: design-export compare ${exportDir} --unity ${keptRun.dir} --report <file.html>`] : []),
          ...(keepCaptures === true && !keptRun ? ["Unity captures were not kept: this comparison step cannot keep them."] : []),
        ];
        return toolResult(lines.join("\n"), {
          screen, entry, verdict, reportPath, verdictFile: v.verdictFile ?? null, compared: v.compared ?? null, topIssues: v.topIssues, notRun: v.notRun, hidden,
          extra: v.extra ?? [], warnings: v.warnings ?? [], colour: v.colour ?? null, notSampled: v.notSampled ?? 0, byClass: v.byClass ?? {}, keptCaptures: keptRun,
          steps: v.timings ?? steps, timings: t.done(),
        }, verdict !== "pass");
      }));
    });
  });
}

/**
 * Why a screen's export is not this exporter's (its `export-report.json` names another tool hash: another exporter
 * version, extraction revision, schema or Chromium), or null when it is, or the report names none.
 */
export function exportOfOtherTool(exportDir: string): string | null {
  let rep: { toolSha?: unknown };
  try { rep = JSON.parse(fs.readFileSync(path.join(exportDir, "export-report.json"), "utf8")); } catch { return null; }
  if (typeof rep?.toolSha !== "string" || rep.toolSha === toolHash()) return null;
  return "its export was made by another version of the exporter, so its goldens may lack what this comparison reads " +
    "(an older export has no ellipsis records, for example)";
}

/** How many failed-<run> folders a screen keeps (the newest); older ones are deleted when a new one is kept. */
export const FAILED_RUNS_KEPT = KEPT;

/**
 * Moves a capture that gave no verdict (`staging`, whatever it holds: PNGs, boxes, the meta file Unity keeps up to date)
 * to `<bookkeeping>/failed-<run>` with the step's log (`unity.log`) and `failure.json` (why, exit code, route, timings);
 * keeps the newest FAILED_RUNS_KEPT such folders. Returns the folder.
 */
export function keepFailedRun(bookkeeping: string, staging: string, failure: { screen: string; entry: string | null; reason: string; code: number | null; via: string | null; log: string; timings: Record<string, number> }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dir = path.join(bookkeeping, `failed-${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(bookkeeping, `failed-${stamp}-${n}`);
  // a locked file (Windows) can stop the move: the captures are copied then, else the reason is recorded; the tool's own
  // "no verdict" answer never depends on it
  let evidence: string | undefined;
  if (fs.existsSync(staging)) {
    try { fs.renameSync(staging, dir); } catch (moveError) {
      try { fs.cpSync(staging, dir, { recursive: true }); } catch (copyError) {
        evidence = `the partial captures could not be moved (${(moveError as Error).message}) or copied (${(copyError as Error).message}); they stay in ${staging}`;
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "unity.log"), failure.log);
  const { log: _log, ...rest } = failure;
  fs.writeFileSync(path.join(dir, "failure.json"), JSON.stringify({ ...rest, ...(evidence ? { evidence } : {}), failedAt: new Date().toISOString(), files: fs.readdirSync(dir).filter((f) => f !== "unity.log").length }, null, 2) + "\n");
  const runs = fs.readdirSync(bookkeeping).filter((n) => n.startsWith("failed-")).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - FAILED_RUNS_KEPT))) fs.rmSync(path.join(bookkeeping, old), { recursive: true, force: true });
  return dir;
}
