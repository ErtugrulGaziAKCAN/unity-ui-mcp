import fs from "node:fs";
import path from "node:path";
import type { DesignUiConfig, RunnerRoute } from "./config.js";
import { BOOKKEEPING_DIR, REPORT_FILE, findEntry, resolveScreen, screenFolders, sourceSha } from "./design.js";

export type ScreenState = "new" | "design-changed" | "imported" | "verified" | "failed";

/** `<designRoot>/<screen>/.design-ui/last-import.json`, written after a successful import. */
export interface ImportRecord {
  screen: string;
  sourceSha: string;
  kitSha: string;
  irSha: string;
  importedAt: string;
  via: RunnerRoute;
  discardManualEdits: boolean;
  /** Milliseconds of the import's steps (export, import, compile), carried into the verification report. */
  timings?: Record<string, number>;
}

/** `<designRoot>/<screen>/.design-ui/last-verify.json`, written after a completed comparison. */
export interface VerifyRecord {
  screen: string;
  sourceSha: string;
  irSha: string;
  verdict: "pass" | "fail";
  reportPath: string;
  verifiedAt: string;
  topIssues: string[];
  notRun: string[];
}

export const bookkeepingDir = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR);
export const exportDirOf = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "export");
export const unityDirOf = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "unity");
export const reportPathOf = (screenDir: string) => path.join(screenDir, REPORT_FILE);
const importFile = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "last-import.json");
const verifyFile = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "last-verify.json");

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export const readLastImport = (screenDir: string) => readJson<ImportRecord>(importFile(screenDir));
export const readLastVerify = (screenDir: string) => readJson<VerifyRecord>(verifyFile(screenDir));
export const writeLastImport = (screenDir: string, r: ImportRecord) => writeJson(importFile(screenDir), r);
export const writeLastVerify = (screenDir: string, r: VerifyRecord) => writeJson(verifyFile(screenDir), r);

export interface ScreenStatus {
  state: ScreenState;
  sourceSha: string;
  /** Source hash at the last successful import, else null. */
  lastImportSha: string | null;
  verdict: "pass" | "fail" | null;
  reportPath: string | null;
}

function statusOf(dir: string): ScreenStatus {
  const cur = sourceSha(dir);
  const imp = readLastImport(dir);
  const ver = readLastVerify(dir);
  // a verdict counts only for the import it verified
  const current = !!imp && !!ver && ver.irSha === imp.irSha && ver.sourceSha === imp.sourceSha;
  let state: ScreenState;
  if (!imp) state = "new";
  else if (imp.sourceSha !== cur) state = "design-changed";
  else if (current) state = ver!.verdict === "pass" ? "verified" : "failed";
  else state = "imported";
  return {
    state, sourceSha: cur, lastImportSha: imp?.sourceSha ?? null,
    verdict: current ? ver!.verdict : null,
    reportPath: current && fs.existsSync(ver!.reportPath) ? ver!.reportPath : null,
  };
}

/** Status of one screen folder under designRoot (by id or path). */
export function screenStatus(cfg: DesignUiConfig, screenId: string): ScreenStatus {
  return statusOf(resolveScreen(screenId, cfg.designRoot).dir);
}

export interface ScreenSummary extends ScreenStatus { screen: string; entry: string | null; problem?: string }

export function listScreens(cfg: DesignUiConfig): ScreenSummary[] {
  return screenFolders(cfg.designRoot).map((screen) => {
    const dir = path.join(cfg.designRoot, screen);
    let entry: string | null = null, problem: string | undefined;
    try { entry = path.relative(dir, findEntry(dir)); } catch (e) { problem = (e as Error).message; }
    return { screen, entry, ...statusOf(dir), ...(problem ? { problem } : {}) };
  });
}
