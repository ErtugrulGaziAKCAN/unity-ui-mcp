import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, type ServerContext } from "../context.js";
import { designPath, findEntry, resolveScreen, sha256, sourceSha } from "../design.js";
import { MISSING } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { CompileWaitTimeout, runUnity, UnityRunnerError } from "../runner.js";
import { bookkeepingDir, exportDirOf, readLastImport, unityDirOf, writeLastImport } from "../status.js";
import { formatFindings } from "./lint.js";

const importArg = z.string().min(1).describe(
  "A screen folder under designRoot (its id or path) with one design page, or the path of one .html / .dc.html page in a " +
  "screen folder (a Claude Design canvas folder with several artboards: the artboard's path). Relative paths are resolved under designRoot.");

export function registerImport(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_import", {
    title: "Import a design into Unity",
    description:
      "Exports one design page under designRoot (lint, browser capture, IR, goldens) and compiles it into the Unity project " +
      "through the Unity runner (the open Editor's bridge, or the configured command). Skips the export when the design and " +
      "kit are unchanged and the Unity call when the IR is unchanged. A page path imports exactly that page (its screen id is its " +
      "data-u-screen); a folder imports its only page. Records <screen folder>/.design-ui/last-import.json. " +
      "Generated Unity files are never edited by hand; an import refuses to overwrite hand edits unless discardManualEdits is true.",
    inputSchema: {
      design: importArg,
      discardManualEdits: z.boolean().optional().describe("Overwrite generated Unity files that were edited by hand (default false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ design, discardManualEdits }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const ref = resolveScreen(design, cfg.designRoot);
      const { dir } = ref;
      // exactly the page a path names; a folder argument takes the folder's only page
      const entry = ref.entry ?? findEntry(dir, cfg.designRoot);
      const entryName = path.relative(dir, entry);
      const page = ref.entry ? designPath(entry, cfg.designRoot) : null;
      // the screen id: the folder's for a folder import; for a page, its data-u-screen (from the IR once it is exported)
      let screen = page ?? ref.screen;
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
      const irBytes = fs.readFileSync(irFile);
      const irSha = sha256(irBytes);
      if (page) screen = irScreen(irBytes) ?? ref.screen;
      const named = page ? `${screen} (${page})` : screen;
      const verifyArg = page ?? screen;

      const discard = discardManualEdits === true;
      if (last && last.irSha === irSha && !discard) {
        if (exported || last.sourceSha !== src || last.kitSha !== kit.sha || last.entry !== entryName || last.screen !== screen) {
          writeLastImport(dir, { ...last, screen, entry: entryName, sourceSha: src, kitSha: kit.sha });
        }
        return toolResult(`${named} is unchanged since the last import (${last.importedAt}); Unity was not called.`, {
          screen, entry: entryName, exported, unityCalled: false, via: last.via, irSha, sourceSha: src, exportDir, timings: t.done(),
        });
      }

      // the command route's done marker: Unity names the IR it imported (a command's exit code alone proves nothing)
      const doneFile = path.join(bookkeepingDir(dir), "import-done.json");
      fs.rmSync(doneFile, { force: true });
      let run;
      try {
        run = await t.async("unity", () => runUnity(cfg, "import", {
          exportDir, outDir: unityDirOf(dir), discardManualEdits: String(discard), importDone: doneFile,
        }, ctx.runnerOptions));
      } catch (e) {
        if (!(e instanceof UnityRunnerError)) throw e;
        if (e instanceof CompileWaitTimeout) {
          // the files were written; only the compile's outcome is missing, so nothing is recorded
          return toolResult(`Imported the files of ${named} into Unity, but ${e.message}. The import is not recorded; import again once Unity has compiled.`,
            { screen, exported, unityCalled: true, via: "editor", unity: e.answer, exportDir, timings: t.done() }, true);
        }
        return toolResult(`Import of ${named} not run: ${e.message}`, { screen, exported, unityCalled: false, exportDir, timings: t.done() }, true);
      }
      if (run.code !== 0) {
        const head = run.code === 2
          ? `Unity cannot import ${named} yet (code 2, via ${run.via}): ${run.logTail}`
          : `Unity import of ${named} failed (exit ${run.code}, via ${run.via}). Log tail:\n${run.logTail}`;
        return toolResult(head, {
          screen, exported, unityCalled: true, via: run.via, code: run.code, logTail: run.logTail, exportDir, unityTimings: run.timings, timings: t.done(),
        }, true);
      }

      const unity = {
        ...(run.answer ? { unity: run.answer } : {}), ...(run.compile ? { compile: run.compile } : {}),
        ...(run.scriptsFailed !== undefined ? { scriptsFailed: run.scriptsFailed } : {}),
      };
      const base = { screen, entry: entryName, exported, unityCalled: true, via: run.via, code: 0, irSha, sourceSha: src, exportDir, logTail: run.logTail, ...unity };
      if (run.via === "command" && !confirmsImport(doneFile, irSha)) {
        return toolResult(`Unity import of ${named} (via command) exited 0 but did not confirm this export: ${fs.existsSync(doneFile) ? "import-done.json names another IR or a failed import" : "no import-done.json"} ` +
          "(the import command must run DesignUiOpsTests.ImportFromEnv or DesignUiBatch.Import, which write it). Nothing was recorded. Log tail:\n" + run.logTail,
        { ...base, unityTimings: run.timings, timings: t.done() }, true);
      }
      // an import counts only when the project's scripts compile with it: a failed, not started or unchecked compile, or
      // scripts that already fail, are never recorded (so the next import calls Unity again instead of skipping it)
      const state = run.scriptsFailed === true || run.compile?.state === "failed" ? "failed" : run.compile && !run.compile.ok ? run.compile.state : null;
      if (state) {
        const errors = run.compile?.errors.length ? run.compile.errors : run.scriptErrors ?? [];
        const why = state === "failed"
          ? "the project's scripts do not compile. Fix these errors in Unity first" + (errors.length ? ":" : " (they are in the Unity Console).")
          : state === "not-started"
            ? "Unity did not start compiling the changed scripts (Auto Refresh is off, or the Editor waits for focus). Bring Unity to the front so it compiles, then import again."
            : "the result of Unity's script compile for this import is unknown (the Editor restarted, or another import superseded this one) and the bridge cannot confirm that the scripts compile. Check the Unity Console, then import again.";
        return toolResult([
          `Imported the files of ${named} into Unity via ${run.via}, but ${why}`,
          ...errors.map((e) => `- ${e}`),
          ...(state === "failed"
            ? ["Errors in files this tool generated come from the design or the generator: change the design (or report the generator bug). " +
               "Importing the same design again changes nothing while the scripts do not compile. The import is not recorded."]
            : ["The import is not recorded."]),
        ].join("\n"), { ...base, unityTimings: run.timings, timings: t.done() }, true);
      }

      const steps: Record<string, number> = { export: t.steps.export };
      if (run.via === "editor") { steps.import = run.timings.request; if (run.timings.compileWait !== undefined) steps.compile = run.timings.compileWait; }
      else steps.import = run.timings.total;
      writeLastImport(dir, {
        screen, entry: entryName, sourceSha: src, kitSha: kit.sha, irSha, importedAt: new Date().toISOString(), via: run.via, discardManualEdits: discard, timings: steps,
      });
      const a = run.answer;
      const what = a
        ? `: ${a.changed.length} file${a.changed.length === 1 ? "" : "s"} changed, ${a.imported.length} imported` +
          (a.compiled.length
            ? `, scripts compiled${run.compile?.state === "reloaded" ? ` and reloaded (${Math.round((run.timings.compileWait ?? 0) / 100) / 10} s)` : " (Unity did not report this import's compile result, but the project's scripts compile)"}`
            : ", no script change")
        : "";
      return toolResult(`Imported ${named} into Unity via ${run.via}${what}${exported ? "" : " (export reused: design and kit unchanged)"}. Next: design_ui_verify { screen: "${verifyArg}" }.`, {
        ...base, unityTimings: run.timings, timings: t.done(),
      });
    });
  });
}

/** The screen id an exported IR names (the page's data-u-screen), else null. */
function irScreen(ir: Buffer): string | null {
  try {
    const s = JSON.parse(ir.toString("utf8"))?.screen;
    return typeof s === "string" && s.length > 0 ? s : null;
  } catch { return null; }
}

/** Whether the command route's import-done.json confirms a successful import of this IR. */
function confirmsImport(file: string, irSha: string): boolean {
  try {
    const done = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(done?.imports) && done.imports.some((e: any) => e?.irSha === irSha && e?.code === 0);
  } catch { return false; }
}
