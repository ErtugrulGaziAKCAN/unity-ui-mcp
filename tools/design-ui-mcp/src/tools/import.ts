import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bridgeStatus } from "../bridge.js";
import { requireConfig, withProgress, type ServerContext } from "../context.js";
import { versionDrift } from "../drift.js";
import { designPath, findEntry, folderScreens, mixedScreens, resolveScreen, sha256, sourceSha } from "../design.js";
import { packageStamp } from "../package-stamp.js";
import { MISSING } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { afterRun, whileBusy } from "./clean.js";
import { dropKeptCaptures } from "../cache.js";
import { CompileWaitTimeout, runUnity, UnityRunnerError, unityIssues, withIssues } from "../runner.js";
import { bookkeepingDir, exportDirOf, readLastImport, unityDirOf, writeLastImport } from "../status.js";
import { formatFindings } from "./lint.js";
import { readScreenContract, type ContractKind, type ContractLoad, type ScreenContract } from "../exporter.js";

const importArg = z.string().min(1).describe(
  "A screen folder under designRoot (its id or path) with one design page, or the path of one .html / .dc.html page in a " +
  "screen folder (a Claude Design canvas folder with several artboards: the artboard's path). Relative paths are resolved under designRoot.");

export function registerImport(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_import", {
    title: "Import a design into Unity",
    description:
      "Exports one design page under designRoot (lint, browser capture, IR, goldens) and compiles it into the Unity project " +
      "through the Unity runner (the open Editor's bridge, or the configured command). Skips the export when the design and " +
      "kit are unchanged and the Unity call when the IR, the kit, the profile and the installed design-ui package are unchanged. A page path imports exactly that page (its screen id is its " +
      "data-u-screen); a folder imports its only page. Records <screen folder>/.design-ui/last-import.json. " +
      "Generated Unity files are never edited by hand; an import refuses to overwrite hand edits unless discardManualEdits is true.",
    inputSchema: {
      design: importArg,
      discardManualEdits: z.boolean().optional().describe("Overwrite generated Unity files that were edited by hand (default false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, // discardManualEdits overwrites hand edits
  }, async ({ design, discardManualEdits }, extra) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const ref = resolveScreen(design, cfg.designRoot);
      // the package the open Editor runs must read what this server exports: another major or IR version stops here
      let drift: ReturnType<typeof versionDrift> = { level: "ok", message: null };
      if (cfg.unityRunner.prefer === "editor") {
        const st = await t.async("bridge", () => bridgeStatus(cfg.projectDir));
        // no bridge for this project, or one that refuses the token: the Unity step cannot run, so nothing is exported (an
        // export would replace the screen's goldens and drop the captures a verify kept). An Editor that is busy or reloading
        // (not-responding) may still answer the import: that case goes on
        if (st.bridge === "not-found" || st.bridge === "unauthorized") {
          const label = ref.entry ? designPath(ref.entry, cfg.designRoot) : ref.screen;
          const why = st.bridge === "not-found"
            ? `Editor not reachable: Unity Editor bridge not found for ${cfg.projectDir}: open this project in Unity with the com.ertugrulgaziakcan.design-ui package ` +
              `(Window > Design UI > Status shows the bridge), or set "unityRunner.prefer": "command" in design-ui.config.json`
            : `the Unity Editor bridge refused this server's token: press Restart in Window > Design UI > Status`;
          return toolResult(`Import of ${label} not run: ${why}. Nothing was exported or written.`,
            { screen: ref.screen, exported: false, unityCalled: false, bridge: st.bridge, timings: t.done() }, true);
        }
        if (st.bridge === "connected") drift = versionDrift(st.version, st.irVersion);
        if (drift.level === "error") {
          const label = ref.entry ? designPath(ref.entry, cfg.designRoot) : ref.screen;
          return toolResult(`Import of ${label} not run: ${drift.message}. Nothing was exported or written.`,
            { screen: ref.screen, exported: false, unityCalled: false, versionDrift: drift, timings: t.done() }, true);
        }
      }
      // captures a verify kept, dropped when this import exports the screen again (said in the answer)
      let keptNote: string | null = null;
      const answer = withWarning(drift.message, await whileBusy(ref.dir, "import", async () => {
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
        // what else decides the compiled screen: the package's compiler and the profile (an unchanged export may still compile
        // differently after a package update; the Unity call is skipped only when these are unchanged too)
        const compiler = t.sync("hash", () => packageStamp(cfg.projectDir));
        const profileSha = t.sync("hash", () => fileSha(path.join(cfg.projectDir, cfg.profileAsset)));
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
        // an import that passed lint has no invalid contract (U-CON-001 is an error), so the contract is valid or absent
        const wiring = wiringSection(out.contract ?? readScreenContract(dir));
        // captures a verify kept were taken against the goldens this export replaced: comparing them again would mislead
        if (exported && dropKeptCaptures(dir, "the screen was exported again, so they no longer match its goldens"))
          keptNote = "The Unity captures a verify kept were removed: this import exported the screen again, so they no longer match its goldens.";
        // capture jobs the design shows in no context have no golden: a verify of this export is incomplete
        const hidden = (out.hidden ?? []).map((h) => h.name);
        const hiddenLine = hidden.length
          ? `\nHidden in the design (no golden, so a verify is incomplete; show them in a state, class or repeat item, or remove their layers): ${hidden.join(", ")}`
          : "";
        if (!fs.existsSync(irFile)) throw new Error(`the export of ${screen} wrote no screen.ir.json in ${exportDir}`);
        const irBytes = fs.readFileSync(irFile);
        const irSha = sha256(irBytes);
        // the screen id is the export's (data-u-screen), the folder's bookkeeping key: the folder's other pages must name it too
        screen = irScreen(irBytes) ?? ref.screen;
        const mixed = mixedScreens(dir, cfg.designRoot, folderScreens(dir).map((x) => (x.page === entryName ? { page: x.page, screen } : x)));
        if (mixed) {
          return toolResult(`Import of ${page ?? screen} stopped: ${mixed}. Unity was not called and nothing was recorded.`,
            { screen, entry: entryName, exported, unityCalled: false, exportDir, timings: t.done() }, true);
        }
        const named = page ? `${screen} (${page})` : screen;
        const verifyArg = page ?? screen;

        const discard = discardManualEdits === true;
        // the generated screen must still be there: an unchanged IR skips Unity only while its folder's manifest exists
        const generated = typeof last?.output === "string" && fs.existsSync(path.join(path.resolve(cfg.projectDir, last.output), GENERATED_MANIFEST));
        if (last && generated && last.irSha === irSha && last.kitSha === kit.sha && (last.compiler ?? null) === compiler && (last.profileSha ?? null) === profileSha && !discard) {
          if (exported || last.sourceSha !== src || last.entry !== entryName || last.screen !== screen) {
            writeLastImport(dir, { ...last, screen, entry: entryName, sourceSha: src });
          }
          return withWiring(toolResult(`${named} is unchanged since the last import (${last.importedAt}); Unity was not called.${hiddenLine}`, {
            screen, entry: entryName, exported, unityCalled: false, via: last.via, irSha, sourceSha: src, exportDir, hidden, timings: t.done(),
          }), wiring);
        }

        // the command route's done marker: Unity names the IR it imported (a command's exit code alone proves nothing)
        const doneFile = path.join(bookkeepingDir(dir), "import-done.json");
        fs.rmSync(doneFile, { force: true });
        let run;
        try {
          run = await t.async("unity", () => runUnity(cfg, "import", {
            exportDir, outDir: unityDirOf(dir), discardManualEdits: String(discard), importDone: doneFile,
          }, withProgress(ctx, extra)));
        } catch (e) {
          if (!(e instanceof UnityRunnerError)) throw e;
          if (e instanceof CompileWaitTimeout) {
            // the files were written; only the compile's outcome is missing, so nothing is recorded
            return toolResult([`Imported the files of ${named} into Unity, but ${e.message}. The import is not recorded; import again once Unity has compiled.`, ...unityIssues(e)].join("\n"),
              { screen, exported, unityCalled: true, via: "editor", unity: e.answer, warnings: e.warnings, errors: e.errors, exportDir, timings: t.done() }, true);
          }
          return toolResult(`Import of ${named} not run: ${e.message}`, { screen, exported, unityCalled: false, exportDir, timings: t.done() }, true);
        }
        if (run.code !== 0) {
          const head = run.code === 2
            ? `Unity cannot import ${named} yet (code 2, via ${run.via}).`
            : `Unity import of ${named} failed (exit ${run.code}, via ${run.via}).`;
          return toolResult(withIssues(head, run), {
            screen, exported, unityCalled: true, via: run.via, code: run.code, warnings: run.warnings, errors: run.errors, logTail: run.logTail,
            exportDir, unityTimings: run.timings, timings: t.done(),
          }, true);
        }

        const unity = {
          ...(run.answer ? { unity: run.answer } : {}), ...(run.compile ? { compile: run.compile } : {}),
          ...(run.scriptsFailed !== undefined ? { scriptsFailed: run.scriptsFailed } : {}),
        };
        const base = {
          screen, entry: entryName, exported, unityCalled: true, via: run.via, code: 0, irSha, sourceSha: src, exportDir,
          warnings: run.warnings, errors: run.errors, logTail: run.logTail, ...unity,
        };
        const confirmed = run.via === "command" ? confirmsImport(doneFile, irSha) : null;
        if (run.via === "command" && !confirmed) {
          return toolResult(withIssues(`Unity import of ${named} (via command) exited 0 but did not confirm this export: ${fs.existsSync(doneFile) ? "import-done.json names another IR or a failed import" : "no import-done.json"} ` +
            "(the import command must run DesignUiOpsTests.ImportFromEnv or DesignUiBatch.Import, which write it). Nothing was recorded.", run),
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
            ...unityIssues(run),
          ].join("\n"), { ...base, unityTimings: run.timings, timings: t.done() }, true);
        }

        const steps: Record<string, number> = { export: t.steps.export };
        if (run.via === "editor") { steps.import = run.timings.request; if (run.timings.compileWait !== undefined) steps.compile = run.timings.compileWait; }
        else steps.import = run.timings.total;
        // where Unity wrote the screen (its answer, or the command route's done marker)
        const output = run.via === "command" ? confirmed?.output ?? null : run.answer?.output ?? null;
        writeLastImport(dir, {
          screen, entry: entryName, sourceSha: src, kitSha: kit.sha, irSha, ...(compiler ? { compiler } : {}), ...(profileSha ? { profileSha } : {}),
          importedAt: new Date().toISOString(), via: run.via, discardManualEdits: discard, timings: steps, ...(output ? { output } : {}),
        });
        const a = run.answer;
        const what = a
          ? `: ${a.changed.length} file${a.changed.length === 1 ? "" : "s"} changed, ${a.imported.length} imported` +
            (a.compiled.length
              ? `, scripts compiled${run.compile?.state === "reloaded" ? ` and reloaded (${Math.round((run.timings.compileWait ?? 0) / 100) / 10} s)` : " (Unity did not report this import's compile result, but the project's scripts compile)"}`
              : ", no script change")
          : "";
        return withWiring(toolResult(withIssues(`Imported ${named} into Unity via ${run.via}${what}${exported ? "" : " (export reused: design and kit unchanged)"}. Next: design_ui_verify { screen: "${verifyArg}" }.${hiddenLine}`, run, false), {
          ...base, hidden, unityTimings: run.timings, timings: t.done(),
        }), wiring);
      }));
      return afterRun(cfg, withLine(keptNote, "keptCapturesRemoved", answer));
    });
  });
}

export interface WiringEntry { kind: ContractKind; name: string; in: string; source: string | null; count?: [number, number] }

/**
 * What the game must back for a screen: every value, action, state and repeat of the contract (texts carry their own English,
 * so they are not wiring), and the requested ones that have no source yet (the named dependencies, same rule as the brief).
 */
export function wiringOf(c: ScreenContract): { entries: WiringEntry[]; dependencies: WiringEntry[] } {
  const items = c.items.filter((i) => i.kind !== "text");
  const entry = (i: (typeof items)[number]): WiringEntry => ({ kind: i.kind, name: i.name, in: i.repeat ?? "screen", source: i.source, ...(i.count ? { count: i.count } : {}) });
  return { entries: items.map(entry), dependencies: items.filter((i) => i.origin === "requested" && !i.source).map(entry) };
}

interface WiringSection { data: { contract: "valid" | "absent"; entries: WiringEntry[]; dependencies: WiringEntry[] }; lines: string[] }

const wiringLine = (e: WiringEntry): string => {
  const head = `- ${e.kind} ${e.name} (${e.in})`;
  if (!e.source) return head;
  if (e.kind === "action") return `${head} → ${e.source}`;
  if (e.kind === "state") return `${head} when ${e.source}`;
  return `${head} ← ${e.source}${e.kind === "repeat" && e.count ? `, count ${e.count[0]}–${e.count[1]}` : ""}`;
};

function wiringSection(load: ContractLoad): WiringSection {
  if (load.state !== "valid") {
    return {
      data: { contract: "absent", entries: [], dependencies: [] },
      lines: ["No screen contract: the wiring list must come from the inventory (the skill's step 3)."],
    };
  }
  const { entries, dependencies } = wiringOf(load.contract);
  return {
    data: { contract: "valid", entries, dependencies },
    lines: [
      "Wiring checklist (from screen.contract.json): connect the generated view to these, then prove each in Play mode:",
      ...entries.map(wiringLine),
      ...(dependencies.length ? [`Named dependencies (no source in the game yet): ${dependencies.map((d) => `${d.kind} ${d.name}`).join(", ")}`] : []),
    ],
  };
}

/** Appends the wiring section to a successful import answer (its first text, and `wiring` in the data). */
function withWiring(result: CallToolResult, w: WiringSection): CallToolResult {
  const content = result.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${c.text}\n${w.lines.join("\n")}` } : c));
  const data = { ...(result.structuredContent ?? {}), wiring: w.data };
  if (content[1]?.type === "text") content[1] = { ...content[1], text: JSON.stringify(data, null, 2) };
  return { ...result, content, structuredContent: data };
}

/** Appends a line to a tool's answer (its first text, and `key: true` in the data). */
function withLine(line: string | null, key: string, result: CallToolResult): CallToolResult {
  if (!line) return result;
  const content = result.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${c.text}\n${line}` } : c));
  const data = result.structuredContent ? { ...result.structuredContent, [key]: true } : undefined;
  if (data && content[1]?.type === "text") content[1] = { ...content[1], text: JSON.stringify(data, null, 2) };
  return { ...result, content, ...(data ? { structuredContent: data } : {}) };
}

/** Appends a version drift warning to a tool's answer (its first text and `versionWarning` in the data). */
function withWarning(message: string | null, result: CallToolResult): CallToolResult {
  if (!message) return result;
  const line = `Warning: ${message}.`;
  const content = result.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${c.text}\n${line}` } : c));
  const data = result.structuredContent ? { ...result.structuredContent, versionWarning: message } : undefined;
  if (data && content[1]?.type === "text") content[1] = { ...content[1], text: JSON.stringify(data, null, 2) };
  return { ...result, content, ...(data ? { structuredContent: data } : {}) };
}

/** The SHA-256 of a file's bytes, or null when it cannot be read. */
function fileSha(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** The screen id an exported IR names (the page's data-u-screen), else null. */
function irScreen(ir: Buffer): string | null {
  try {
    const s = JSON.parse(ir.toString("utf8"))?.screen;
    return typeof s === "string" && s.length > 0 ? s : null;
  } catch { return null; }
}

/** The name of the manifest Unity writes in a screen's generated folder (ScreenCompiler.ManifestFileName). */
const GENERATED_MANIFEST = ".design-ui.json";

/**
 * The command route's import-done.json entry that confirms a successful import of this IR (with the generated folder Unity
 * names, when it does), or null.
 */
function confirmsImport(file: string, irSha: string): { output: string | null } | null {
  try {
    const done = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = Array.isArray(done?.imports) ? done.imports.find((x: any) => x?.irSha === irSha && x?.code === 0) : undefined;
    return e ? { output: typeof e.output === "string" && e.output.length > 0 ? e.output : null } : null;
  } catch { return null; }
}
