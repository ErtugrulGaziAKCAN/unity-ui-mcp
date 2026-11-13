import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { DesignUiConfig, UnityStep } from "./config.js";
import { readThresholds, runCompare, runExport, summarizeIssues, writeReport, writeVerdict, type Finding, type KitConfig } from "./exporter.js";

export interface ExportOutcome {
  /** false when lint found errors: nothing but the lint report was written. */
  ok: boolean;
  findings: Finding[];
  timings?: Record<string, number>;
  /** true when the exporter found the design, kit and tool unchanged and kept the previous export. */
  skipped?: boolean;
}
/** Exports one design page into `outDir` (screen.ir.json, goldens/, assets/, fixtures/, lint-report.json). */
export type ExportScreen = (entry: string, kit: KitConfig, outDir: string, browser: () => Promise<Browser>) => Promise<ExportOutcome>;

export interface CompareOutcome {
  pass: boolean;
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
  /** Checks skipped for the whole screen (e.g. no IR). */
  warnings?: string[];
  /** Painted backgrounds left without any colour sample, over all captures. */
  notSampled?: number;
  /**
   * Makes this run the screen's result: moves the Unity captures (to `opts.unityDir`) and the difference images into
   * place and writes the report and verdict.json. Called only once a verdict exists, right before last-verify.json.
   */
  publish?: () => void;
  /** Drops this run's derived files; the previous report, captures and verdict stay as they were. */
  discard?: () => void;
}
/**
 * Compares the Unity captures in `unityDir` (a staging folder) with the goldens in `exportDir`; `publish()` writes the
 * HTML report. `timings`: steps measured before the comparison (import, compile, capture), recorded in the report;
 * `unityDir`: where the captures live once published (default: where they are).
 */
export type CompareScreen = (exportDir: string, unityDir: string, reportFile: string, opts?: { timings?: Record<string, number>; unityDir?: string }) => Promise<CompareOutcome>;

/** The pipeline steps that run inside this server. A null step is not installed in this version. */
export interface Pipeline {
  exportScreen: ExportScreen | null;
  compareScreen: CompareScreen | null;
  /**
   * Whether the Unity side of this version can capture a compiled screen for verification (the com.unity.design-ui
   * capture test). Without it design_ui_verify answers "not available yet" and runs nothing.
   */
  unityCapture?: boolean;
}

/**
 * What this version ships: the exporter's export step runs in this process on the server's warm browser (lint, IR,
 * baked effects, goldens, assets, sample data), and the comparison of Unity captures with the goldens writes the HTML
 * report (`<screen>/report.html`; difference images and verdict.json in `<screen>/.design-ui/compare/`). The Unity
 * side (com.unity.design-ui) compiles an export (import, code 0 with a log) and captures a compiled screen for every
 * golden (the env-driven EditMode test DesignCaptureTests.CaptureFromEnv, finished by capture-done.json); whether those
 * Unity steps can run depends on the project's runner configuration (see unityStep).
 */
export const INSTALLED_PIPELINE: Pipeline = {
  exportScreen: async (entry, kit, outDir, browser) => {
    // a lint failure keeps the previous export; its report goes next to the export folder
    const r = await runExport(entry, kit, outDir, { browser, lintReportFile: path.join(path.dirname(outDir), "lint-report.json") });
    return { ok: r.ok, findings: r.findings, timings: { ...r.timings, total: r.totalMs }, skipped: r.skipped };
  },
  compareScreen: async (exportDir, unityDir, reportFile, opts = {}) => {
    // derived files live in the screen's bookkeeping folder, next to the Unity captures (a dot folder: not design
    // source); this run's go to staging folders until publish(), so a run without a verdict changes nothing
    const finalUnity = opts.unityDir ?? unityDir;
    const work = path.join(path.dirname(finalUnity), "compare"), next = `${work}.next`;
    const rm = (p: string) => fs.rmSync(p, { recursive: true, force: true });
    rm(next);
    const v = await runCompare(exportDir, unityDir, readThresholds(), { diffDir: path.join(next, "diff"), timings: opts.timings });
    const verdictFile = path.join(work, "verdict.json");
    return {
      pass: v.pass, topIssues: summarizeIssues(v, 20, { notRun: false }), notRun: v.notRun, compared: v.captures.length,
      extra: v.extra, verdictFile, timings: v.timings, warnings: v.warnings,
      notSampled: v.captures.reduce((a, c) => a + c.notSampled.length, 0),
      publish: () => {
        if (path.resolve(finalUnity) !== path.resolve(unityDir)) { rm(finalUnity); fs.renameSync(unityDir, finalUnity); }
        rm(work);
        if (fs.existsSync(next)) fs.renameSync(next, work);
        for (const c of v.captures) if (c.diff) c.diff = path.join(work, path.relative(next, c.diff));
        writeVerdict(v, verdictFile);
        writeReport(v, exportDir, finalUnity, reportFile);
      },
      discard: () => rm(next),
    };
  },
  unityCapture: true,
};

/** Why a step is unavailable, worded for the AI client and the user. */
export const MISSING = {
  export: "the design export step (browser capture to screen IR, goldens and assets) is not installed in this version of unity-ui-mcp",
  compile: "the Unity compile runs on an export, so it cannot run without the export step",
  compare: "verification (Unity capture and comparison against the design) is not installed in this version of unity-ui-mcp",
  capture: "the Unity capture (the com.unity.design-ui test that renders the compiled screen for every golden capture) is not installed in this pipeline; the comparison against the design and the HTML report run once it is",
};

/** Whether a Unity step can run with the project's configuration, and how (for status, instructions and verify). */
export interface UnityStepRoute { ready: boolean; how: string }

/**
 * import and kitSync run on `unityRunner.prefer`, capture on `unityRunner.captureVia`. The Editor route needs the open
 * Editor's bridge (checked when the step runs; design_ui_status shows it); the package has no Editor capture, so a
 * capture needs the command route. The command route needs its argv template.
 */
export function unityStep(cfg: DesignUiConfig | null, step: UnityStep): UnityStepRoute {
  if (!cfg) return { ready: false, how: "design-ui.config.json is missing or invalid" };
  const route = step === "capture" ? cfg.unityRunner.captureVia : cfg.unityRunner.prefer;
  if (route === "editor") {
    return step === "capture"
      ? { ready: false, how: "the com.unity.design-ui package has no Editor capture (the open Editor is never put into a capture); set \"unityRunner.captureVia\": \"command\" with a capture command in design-ui.config.json" }
      : { ready: true, how: "in the open Unity Editor through its bridge (Window > Design UI > Status), which answers code 0 with a log" };
  }
  const argv = cfg.unityRunner.command[step];
  return argv.length
    ? { ready: true, how: `through the configured command (${path.basename(argv[0])}${argv.length > 1 ? " …" : ""})` }
    : { ready: false, how: `"unityRunner.command.${step}" is not configured in design-ui.config.json` };
}
