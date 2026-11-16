import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeBridge, type BridgeStatus } from "../bridge.js";
import type { ServerContext } from "../context.js";
import { requireConfig } from "../context.js";
import { designPath, findEntry, resolveScreen } from "../design.js";
import { mb, screenCache, screenCaches } from "../cache.js";
import { versionDrift } from "../drift.js";
import { IR_VERSION, readScreenContract, viewportClassOf } from "../exporter.js";
import { cloneKitMessage, isCloneKit } from "../kit-location.js";
import { chromiumSandbox } from "../exporter.js";
import { OLD_PACKAGE_NAME, oldPackageId, PACKAGE_NAME } from "../package-stamp.js";
import { MISSING, unityStep } from "../pipeline.js";
import { guarded, Timings, toolResult } from "../result.js";
import { exportDirOf, importedEntry, readLastImport, readLastVerify, statusOf } from "../status.js";
import { kitViewports } from "./rules.js";
import { VERSION } from "../version.js";

/** The screen argument of status and verify. */
export const SCREEN_ARG = "Screen id (the data-u-screen its pages name, or its folder's name under designRoot), the screen folder's path, or " +
  "the path of one of its .html / .dc.html pages (a canvas folder with several artboards: the artboard that was imported). Relative paths are resolved under designRoot.";

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
    design_ui_rules: { available: true, note: "live (kit RULES.md, attributes, text styles, allowed CSS and every lint rule with its fix)" },
    design_ui_list: { available: true, note: "live" },
    design_ui_brief: { available: true, note: "live (the screen contract as a design brief)" },
    design_ui_lint: { available: true, note: "live (real lint in Chromium with the kit fonts)" },
    design_ui_status: { available: true, note: "live" },
    design_ui_import: !exp
      ? { available: false, note: `not available yet: ${MISSING.export}; ${MISSING.compile}` }
      : unprobed(compile)
        ? { available: false, needsEditor: true, note: `live ${whileEditor}: export (lint, IR, goldens, assets), then the Unity compile ${compile.how}` }
        : compile.ready
          ? { available: true, needsEditor: compile.needsEditor, note: `live: export (lint, IR, goldens, assets), then the Unity compile ${compile.how}` }
          : compile.needsEditor
            ? { available: false, needsEditor: true, note: `${compile.how}; the export is live, the Unity compile needs the open Unity Editor with the com.ertugrulgaziakcan.design-ui bridge` }
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
          ? { available: false, needsEditor: true, note: `${kit.how}; kit sync needs the open Unity Editor with the com.ertugrulgaziakcan.design-ui bridge` }
          : { available: false, note: `the Unity kit sync cannot run: ${kit.how}` },
    design_ui_clean: { available: true, note: "live (reports with dryRun, or runs, the cleanup of the screens' bookkeeping that import and verify also run by themselves)" },
  };
}

export function registerStatus(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_status", {
    title: "Status",
    description:
      "Without a screen: what this server version supports, its configuration, the Unity bridge and the disk the screens' " +
      "bookkeeping takes (per screen and in total, against cacheBudgetMB). With a screen: its hashes, last import, last verdict, " +
      "report and bookkeeping size.",
    inputSchema: { screen: z.string().min(1).optional().describe(SCREEN_ARG) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ screen }) => {
    const t = new Timings();
    return guarded(t, async () => {
      if (screen !== undefined) {
        const cfg = requireConfig(ctx);
        const ref = resolveScreen(screen, cfg.designRoot);
        const { dir } = ref;
        const lastImport = readLastImport(dir), lastVerify = readLastVerify(dir);
        const imported = importedEntry(dir, lastImport);
        // the page asked about, else the folder's last import, else the page the folder resolves to
        let entry: string | null = ref.entry ? path.relative(dir, ref.entry) : imported;
        if (entry === null) { try { entry = path.relative(dir, findEntry(dir, cfg.designRoot)); } catch { /* reported by list */ } }
        const s = t.sync("hash", () => statusOf(dir, ref.entry ? entry : null));
        // the screen id its pages name (data-u-screen): the bookkeeping key
        const id = ref.screen;
        const label = ref.entry ? designPath(ref.entry, cfg.designRoot) : id;
        const other = ref.entry && lastImport && imported !== entry;
        const cache = screenCache(cfg.designRoot, path.basename(dir));
        const contract = readScreenContract(dir);
        const contractProblems = contract.state === "invalid" ? contract.problems.length : 0;
        const data = {
          screen: id, contract: contract.state, contractProblems, folder: dir, entry, ...s, lastImport, lastVerify, exportDir: exportDirOf(dir),
          cache: { bytes: cache.bytes, exportBytes: cache.exportBytes, busy: cache.busy },
          manualEdits: null, pendingTranslations: null,
          note: "manual edits and pending translations are reported by the Unity package's import pipeline (not available in this version)",
          timings: t.done(),
        };
        const lines = [
          `${label}: ${s.state}${ref.entry && lastImport && !other ? ` (screen ${id})` : ""}`,
          `source sha ${s.sourceSha.slice(0, 12)}, ` + (other
            ? `not the folder's last import (${imported ?? "another page"}, ${lastImport!.importedAt})`
            : s.lastImportSha && lastImport ? `last import ${lastImport.importedAt} via ${lastImport.via}` : "never imported"),
          `contract: ${contract.state}${contractProblems ? ` (${contractProblems} problem${contractProblems === 1 ? "" : "s"})` : ""}`,
          s.verdict ? `last verdict: ${s.verdict} (${s.reportPath ?? "report missing"})` : "no verdict",
          `bookkeeping: ${mb(cache.bytes)} (export ${mb(cache.exportBytes)})${cache.busy ? ", an import or verify is running" : ""}`,
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
      const old = oldPackageId(ctx.projectDir);
      const oldId = old.length === 0 ? null : {
        id: OLD_PACKAGE_NAME, where: old,
        fix: `the package id is ${PACKAGE_NAME} since 0.1.0: run scripts/setup.sh of the unity-ui-mcp clone again (it replaces the old ` +
          `dependency key and git URL path), or replace "${OLD_PACKAGE_NAME}" with "${PACKAGE_NAME}" in the manifest and the URL's ` +
          `path=/packages/${PACKAGE_NAME} by hand`,
      };
      const caches = cfg ? t.sync("cache", () => screenCaches(cfg.designRoot)) : [];
      const cacheTotal = caches.reduce((a, c) => a + c.bytes, 0);
      const cache = cfg ? {
        total: cacheTotal, budget: Math.round(cfg.cacheBudgetMB * 1024 * 1024),
        screens: [...caches].sort((a, b) => b.bytes - a.bytes).map((c) => ({ folder: c.folder, bytes: c.bytes, exportBytes: c.exportBytes, lastUsed: new Date(c.lastUsed).toISOString(), busy: c.busy })),
      } : null;
      const sandbox = chromiumSandbox();
      // the kit's viewports by class (exact: every kit value whole device px; scaled: laid out and verified, exempt from those rules)
      let viewports: { exact: [number, number][]; scaled: [number, number][]; text: string } | null = null;
      if (cfg && fs.existsSync(path.join(cfg.kitDir, "kit.config.json"))) {
        try {
          const kit = ctx.runtime.kit(cfg.kitDir).kit;
          viewports = {
            exact: kit.viewports.filter((v) => viewportClassOf(kit.scaledViewports, v) === "exact"),
            scaled: kit.viewports.filter((v) => viewportClassOf(kit.scaledViewports, v) === "scaled"),
            text: kitViewports(kit),
          };
        } catch (e) { viewports = { exact: [], scaled: [], text: `kit.config.json cannot be read: ${(e as Error).message}` }; }
      }
      let screenContract: "optional" | "required" | null = null;
      if (cfg && fs.existsSync(path.join(cfg.kitDir, "kit.config.json"))) {
        try { screenContract = ctx.runtime.kit(cfg.kitDir).kit.screenContract ?? "optional"; } catch { /* reported by the viewports line */ }
      }
      const lines = [
        `design-ui MCP server ${VERSION} for ${ctx.projectDir}`,
        cfg ? `config: ${cfg.configPath} (designRoot ${cfg.designRoot}, Unity runner ${cfg.unityRunner.prefer})` : `config problem: ${ctx.configError}`,
        ...(cfg && isCloneKit(cfg.kitDir) ? [`warning: ${cloneKitMessage(cfg.kitDir, cfg.designRoot, cfg.configPath)}`] : []),
        ...(screenContract ? [`screen contract: ${screenContract} (kit.config.json screenContract)`] : []),
        ...(viewports ? [`viewports: ${viewports.text} (exact: every kit value is whole device px; scaled: verified within ±1 device px, exempt from the whole-pixel rules)`] : []),
        ...(oldId ? [`old package id: ${OLD_PACKAGE_NAME} in ${old.join(", ")}; ${oldId.fix}`] : []),
        ...(unity ? [`Unity bridge: ${unity.bridge} — ${unity.detail}`] : []),
        ...(unity?.bridge === "connected" && unity.version
          ? [(() => {
            const d = versionDrift(unity.version, unity.irVersion);
            const head = `package version: ${unity.version}, reads IR version ${unity.irVersion ?? "(not reported)"} (server ${VERSION}, writes IR version ${IR_VERSION})`;
            return d.level === "ok" ? `${head}: matches` : `${head}: ${d.level === "error" ? "imports refused" : "minor drift"}: ${d.message}`;
          })()]
          : []),
        `browser: ${ctx.runtime.browserWarm ? "warm" : "not started (starts on the first lint)"}` +
          (sandbox ? `, ${sandbox.enabled ? "with Chromium's sandbox" : `without Chromium's sandbox (${sandbox.reason})`}` : ""),
        ...(cache ? [`bookkeeping: ${mb(cache.total)} of the ${mb(cache.budget)} budget in ${caches.length} screen folder${caches.length === 1 ? "" : "s"}` +
          (caches.length ? ` (largest: ${cache.screens.slice(0, 5).map((c) => `${c.folder} ${mb(c.bytes)}`).join(", ")})` : "") +
          "; cleanup runs after every import and verify, design_ui_clean reports or runs it now"] : []),
        "tools:",
        ...Object.entries(tools).map(([name, a]) => `- ${name}: ${a.note}`),
      ];
      return toolResult(lines.join("\n"), {
        server: "design-ui", version: VERSION, project: ctx.projectDir, config, screenContract, viewports: viewports ? { exact: viewports.exact, scaled: viewports.scaled } : null,
        package: { id: PACKAGE_NAME, oldId }, tools,
        pipeline: { export: !!ctx.pipeline.exportScreen, compare: !!ctx.pipeline.compareScreen, capture: !!ctx.pipeline.unityCapture },
        unity, versionDrift: unity?.bridge === "connected" ? versionDrift(unity.version, unity.irVersion) : null, irVersion: IR_VERSION,
        browser: { warm: ctx.runtime.browserWarm, launches: ctx.runtime.browserLaunches, sandbox }, cache, timings: t.done(),
      });
    });
  });
}
