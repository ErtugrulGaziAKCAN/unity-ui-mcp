import type { Browser } from "playwright";
import type { Finding, KitConfig } from "./exporter.js";

export interface ExportOutcome {
  /** false when lint found errors: nothing but the lint report was written. */
  ok: boolean;
  findings: Finding[];
  timings?: Record<string, number>;
}
/** Exports one design page into `outDir` (screen.ir.json, goldens/, assets/, fixtures/, lint-report.json). */
export type ExportScreen = (entry: string, kit: KitConfig, outDir: string, browser: Browser) => Promise<ExportOutcome>;

export interface CompareOutcome {
  pass: boolean;
  /** Short human-readable issues, worst first. */
  topIssues: string[];
  /** Captures that could not be compared (never counted as a pass). */
  notRun: string[];
}
/** Compares the Unity captures in `unityDir` with the goldens in `exportDir` and writes the HTML report. */
export type CompareScreen = (exportDir: string, unityDir: string, reportFile: string) => Promise<CompareOutcome>;

/** The pipeline steps that run inside this server. A null step is not installed in this version. */
export interface Pipeline {
  exportScreen: ExportScreen | null;
  compareScreen: CompareScreen | null;
}

/**
 * What this version ships. The exporter's `export` and `compare` commands are still being built; wire them in here
 * when they land and design_ui_import / design_ui_verify light up without other changes.
 */
export const INSTALLED_PIPELINE: Pipeline = { exportScreen: null, compareScreen: null };

/** Why a step is unavailable, worded for the AI client and the user. */
export const MISSING = {
  export: "the design export step (browser capture to screen IR, goldens and assets) is not installed in this version of unity-ui-mcp",
  compile: "the Unity side (IR compiler and import into the open Editor) arrives with the import pipeline of the com.unity.design-ui package; until then the Editor answers \"Not available yet\"",
  compare: "verification (Unity capture and comparison against the design) is not installed in this version of unity-ui-mcp",
};
