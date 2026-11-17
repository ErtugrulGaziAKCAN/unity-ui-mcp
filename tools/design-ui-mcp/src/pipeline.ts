import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { BridgeStatus } from "./bridge.js";
import { KEPT_CAPTURES_DIR } from "./cache.js";
import type { DesignUiConfig, UnityStep } from "./config.js";
import type { ContractLoad } from "./exporter.js";
import { readThresholds, runCompare, runExport, summarizeIssues, writeReport, writeReportPictures, writeVerdict, type ClassSummary, type Finding, type KitConfig, type ReportPictures, type ViewportClass } from "./exporter.js";

export interface ExportOutcome {
  /** false when lint found errors: nothing but the lint report was written. */
  ok: boolean;
  findings: Finding[];
  /** Capture jobs the design shows in no context (no golden): a verify of this export is incomplete. */
  hidden?: { name: string; reason: string }[];
  timings?: Record<string, number>;
  /** true when the exporter found the design, kit and tool unchanged and kept the previous export. */
  skipped?: boolean;
  /** The screen contract read beside the design (absent: none, or an exporter that does not report it). */
  contract?: ContractLoad;
  /** The exporter's warnings, e.g. boxes estimated over 200 MB (absent: none, or an exporter that does not report them). */
  warnings?: string[];
}
/**
 * Exports one design page into `outDir` (screen.ir.json, goldens/, assets/, fixtures/, lint-report.json). `log` gets the
 * lines the exporter prints while it runs (before capturing: the captures and the estimated size of their boxes).
 */
export type ExportScreen = (entry: string, kit: KitConfig, outDir: string, browser: () => Promise<Browser>, log?: (line: string) => void) => Promise<ExportOutcome>;

export interface CompareOutcome {
  pass: boolean;
  /** "fail" when a capture fails or did not run; else "incomplete" when the design hides a job in every context; else "pass". */
  status?: "pass" | "fail" | "incomplete";
  /** Jobs the design shows in no context: no golden, not compared (the screen is incomplete). */
  hidden?: string[];
  /** Short human-readable issues, worst first. */
  topIssues: string[];
  /** Captures that could not be compared (never counted as a pass). */
  notRun: string[];
  /** Captures compared; 0 means the Unity capture produced nothing to compare (no verdict). */
  compared?: number;
  /** Unity captures without a design golden (listed, not failures). */
  extra?: string[];
  /** The machine-readable verdict written next to the report's data. */
  verdictFile?: string;
  /** Per-step milliseconds as recorded in the report. */
  timings?: Record<string, number>;
  /** Checks skipped for the whole screen (e.g. no IR), and a capture in a colour path that differs from the design. */
  warnings?: string[];
  /** The Unity project's colour space and the colour path the capture rendered with (null when unknown). */
  colour?: { space: string; path: string } | null;
  /** Painted backgrounds left without any colour sample, over all captures. */
  notSampled?: number;
  /** Per viewport class (exact, scaled): its viewports and how many captures passed, failed or did not run there. */
  byClass?: Partial<Record<ViewportClass, ClassSummary>>;
  /**
   * Makes this run the screen's result: writes the report (with the pictures it keeps of failing captures) and
   * verdict.json, then deletes this run's difference images, the previous run's captures and any captures an earlier
   * verify kept, and this run's Unity captures unless the comparison was asked to keep them (`keepCaptures`: they move to
   * `keptCaptures`). Called only once a verdict exists, right before last-verify.json.
   */
  publish?: () => void;
  /** Where publish() keeps this run's Unity captures (`keepCaptures`); null when it deletes them. */
  keptCaptures?: string | null;
  /** Drops this run's derived files; the previous report, captures and verdict stay as they were. */
  discard?: () => void;
}
/**
 * Compares the Unity captures in `unityDir` (a staging folder) with the goldens in `exportDir`; `publish()` writes the
 * HTML report. `timings`: steps measured before the comparison (import, compile, capture), recorded in the report;
 * `unityDir`: where the captures live once published (default: where they are); `keepCaptures`: publish() keeps the
 * run's Unity captures (the whole capture folder: PNGs, boxes, meta and done marker) in the bookkeeping's
 * KEPT_CAPTURES_DIR next to `unityDir`, for an offline comparison, instead of deleting them.
 */
export type CompareScreen = (exportDir: string, unityDir: string, reportFile: string, opts?: { timings?: Record<string, number>; unityDir?: string; keepCaptures?: boolean }) => Promise<CompareOutcome>;

/** The pipeline steps that run inside this server. A null step is not installed in this version. */
export interface Pipeline {
  exportScreen: ExportScreen | null;
  compareScreen: CompareScreen | null;
  /**
   * Whether the Unity side of this version can capture a compiled screen for verification (the
   * com.ertugrulgaziakcan.design-ui capture test). Without it design_ui_verify answers "not available yet" and runs nothing.
   */
  unityCapture?: boolean;
}

/**
 * What this version ships: the exporter's export step runs in this process on the server's warm browser (lint, IR,
 * baked effects, goldens, assets, sample data), and the comparison of Unity captures with the goldens writes the HTML
 * report (`<screen>/report.html`; difference images and verdict.json in `<screen>/.design-ui/compare/`). The Unity
 * side (com.ertugrulgaziakcan.design-ui) compiles an export (import, code 0 with a log) and captures a compiled screen
 * for every golden (the env-driven EditMode test DesignCaptureTests.CaptureFromEnv, finished by capture-done.json);
 * whether those Unity steps can run depends on the project's runner configuration (see unityStep).
 */
export const INSTALLED_PIPELINE: Pipeline = {
  exportScreen: async (entry, kit, outDir, browser, log) => {
    // a lint failure keeps the previous export; its report goes next to the export folder
    const r = await runExport(entry, kit, outDir, { browser, log, lintReportFile: path.join(path.dirname(outDir), "lint-report.json") });
    return {
      ok: r.ok, findings: r.findings, timings: { ...r.timings, total: r.totalMs }, skipped: r.skipped, hidden: r.hidden, contract: r.contract,
      warnings: r.warnings,
    };
  },
  compareScreen: async (exportDir, unityDir, reportFile, opts = {}) => {
    // derived files live in the screen's bookkeeping folder (a dot folder: not design source); this run's go to staging
    // folders until publish(), so a run without a verdict changes nothing. The report keeps pictures of its failing
    // captures (report/); the Unity captures and difference images go once it is written.
    const finalUnity = opts.unityDir ?? unityDir;
    const book = path.dirname(finalUnity);
    const work = path.join(book, "compare"), next = `${work}.next`;
    const pics = path.join(book, "report"), picsNext = `${pics}.next`;
    const keptDir = opts.keepCaptures ? path.join(book, KEPT_CAPTURES_DIR) : null;
    const rm = (p: string) => fs.rmSync(p, { recursive: true, force: true });
    rm(next);
    rm(picsNext);
    const v = await runCompare(exportDir, unityDir, readThresholds(), { diffDir: path.join(next, "diff"), timings: opts.timings });
    const staged = await writeReportPictures(v, exportDir, unityDir, picsNext);
    const verdictFile = path.join(work, "verdict.json");
    return {
      pass: v.pass, status: v.status, hidden: v.hidden, topIssues: summarizeIssues(v, 20, { notRun: false }), notRun: v.notRun, compared: v.captures.length,
      extra: v.extra, verdictFile, timings: v.timings, warnings: v.warnings, colour: v.colour ?? null,
      notSampled: v.captures.reduce((a, c) => a + c.notSampled.length, 0), byClass: v.byClass, keptCaptures: keptDir,
      publish: () => {
        rm(pics);
        if (fs.existsSync(picsNext)) fs.renameSync(picsNext, pics);
        const at = (f: string) => path.join(pics, path.relative(picsNext, f));
        const kept: ReportPictures = new Map([...staged].map(([k, p]) => [k, {
          ...p, design: p.design ? at(p.design) : null, unity: p.unity ? at(p.unity) : null, diff: p.diff ? at(p.diff) : null,
          crops: p.crops.map((c) => ({ ...c, design: at(c.design), unity: at(c.unity), diff: c.diff ? at(c.diff) : null })),
        }]));
        for (const c of v.captures) c.diff = null;
        rm(work);
        fs.mkdirSync(work, { recursive: true });
        writeVerdict(v, verdictFile);
        writeReport(v, exportDir, finalUnity, reportFile, kept, { keptCaptures: keptDir ?? undefined });
        // what the report no longer needs: this run's difference images, the previous run's captures and the captures an
        // earlier verify kept; this run's captures too, unless asked to keep them
        rm(next);
        rm(path.join(book, KEPT_CAPTURES_DIR));
        if (keptDir) {
          try { fs.renameSync(unityDir, keptDir); } catch { fs.cpSync(unityDir, keptDir, { recursive: true }); }
        }
        rm(unityDir);
        rm(finalUnity);
      },
      discard: () => { rm(next); rm(picsNext); },
    };
  },
  unityCapture: true,
};

/** Why a step is unavailable, worded for the AI client and the user. */
export const MISSING = {
  export: "the design export step (browser capture to screen IR, goldens and assets) is not installed in this version of unity-ui-mcp",
  compile: "the Unity compile runs on an export, so it cannot run without the export step",
  compare: "verification (Unity capture and comparison against the design) is not installed in this version of unity-ui-mcp",
  capture: "the Unity capture (the com.ertugrulgaziakcan.design-ui test that renders the compiled screen for every golden capture) is not installed in this pipeline; the comparison against the design and the HTML report run once it is",
};

/**
 * Whether a Unity step can run, and how (for status, instructions and verify). `needsEditor`: the step runs in the open
 * Editor, so it is live only while the bridge answers; `ready` then says whether it answered at the last probe (false
 * when no probe was made).
 */
export interface UnityStepRoute { ready: boolean; how: string; needsEditor?: boolean }

/**
 * import and kitSync run on `unityRunner.prefer`, capture on `unityRunner.captureVia`. The Editor route is live only when
 * the open Editor's bridge answers (`bridge`: a probe from probeBridge; undefined when none was made); the package has
 * no Editor capture, so a capture needs the command route. The command route needs its argv template.
 */
export function unityStep(cfg: DesignUiConfig | null, step: UnityStep, bridge?: BridgeStatus | null): UnityStepRoute {
  if (!cfg) return { ready: false, how: "design-ui.config.json is missing or invalid" };
  const route = step === "capture" ? cfg.unityRunner.captureVia : cfg.unityRunner.prefer;
  if (route === "editor") {
    if (step === "capture") {
      return { ready: false, how: "the com.ertugrulgaziakcan.design-ui package has no Editor capture (the open Editor is never put into a capture); set \"unityRunner.captureVia\": \"command\" with a capture command in design-ui.config.json" };
    }
    if (!bridge) return { ready: false, needsEditor: true, how: "in the open Unity Editor through its bridge (Window > Design UI > Status)" };
    return bridge.bridge === "connected"
      ? { ready: true, needsEditor: true, how: `in the open Unity Editor (bridge on 127.0.0.1:${bridge.port}), which answers code 0 with a log` }
      : { ready: false, needsEditor: true, how: `Editor not reachable: ${bridge.detail}` };
  }
  const argv = cfg.unityRunner.command[step];
  return argv.length
    ? { ready: true, how: `through the configured command (${path.basename(argv[0])}${argv.length > 1 ? " …" : ""})` }
    : { ready: false, how: `"unityRunner.command.${step}" is not configured in design-ui.config.json` };
}
