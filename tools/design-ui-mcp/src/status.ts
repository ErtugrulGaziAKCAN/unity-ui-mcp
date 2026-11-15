import fs from "node:fs";
import path from "node:path";
import { KEPT_CAPTURES_DIR } from "./cache.js";
import type { DesignUiConfig, RunnerRoute } from "./config.js";
import { BOOKKEEPING_DIR, REPORT_FILE, findEntry, folderScreenId, resolveScreen, screenFolders, sourceSha } from "./design.js";

export type ScreenState = "new" | "design-changed" | "imported" | "verified" | "failed" | "incomplete";

/** `<designRoot>/<screen>/.design-ui/last-import.json`, written after a successful import. */
export interface ImportRecord {
  /** The IR's screen id (the page's data-u-screen): the bookkeeping key (records of older versions may hold the folder name). */
  screen: string;
  /** The page that was imported, relative to the screen folder (absent in records of older versions). */
  entry?: string;
  sourceSha: string;
  kitSha: string;
  irSha: string;
  /** The design-ui package the screen was compiled with (`packageStamp`); absent when the project's package could not be read. */
  compiler?: string;
  /** SHA-256 of the DesignUiProfile asset file at the import; absent when it could not be read. */
  profileSha?: string;
  importedAt: string;
  via: RunnerRoute;
  discardManualEdits: boolean;
  /** Milliseconds of the import's steps (export, import, compile), carried into the verification report. */
  timings?: Record<string, number>;
}

/** `<designRoot>/<screen>/.design-ui/last-verify.json`, written after a completed comparison. */
export interface VerifyRecord {
  screen: string;
  /** The imported page this verdict is for, relative to the screen folder. */
  entry?: string;
  sourceSha: string;
  irSha: string;
  /** "incomplete": nothing failed or went unrun, but the design hides a job in every context (not compared); never a pass. */
  verdict: "pass" | "fail" | "incomplete";
  reportPath: string;
  verifiedAt: string;
  topIssues: string[];
  notRun: string[];
  /** Jobs the design shows in no context (not compared). */
  hidden?: string[];
  /** Where this run's Unity captures were kept on request (verify's keepCaptures); absent when they were deleted. */
  keptCaptures?: string;
}

export const bookkeepingDir = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR);
export const exportDirOf = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "export");
export const unityDirOf = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, "unity");
export const keptCapturesDirOf = (screenDir: string) => path.join(screenDir, BOOKKEEPING_DIR, KEPT_CAPTURES_DIR);
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

/**
 * The page a screen folder's last import exported, relative to the folder: the record's entry, or for a record of an
 * older version (which imported only the folder's own page) the page the folder resolves to; null when unknown.
 */
export function importedEntry(dir: string, imp: ImportRecord | null): string | null {
  if (!imp) return null;
  if (imp.entry) return imp.entry;
  try { return path.relative(dir, findEntry(dir)); } catch { return null; }
}

export interface ScreenStatus {
  state: ScreenState;
  sourceSha: string;
  /** Source hash at the last successful import, else null. */
  lastImportSha: string | null;
  verdict: "pass" | "fail" | "incomplete" | null;
  reportPath: string | null;
}

/**
 * Status of a screen folder, or of one of its pages (`entry`, relative to the folder): the folder keeps one import, so a
 * page that is not the folder's last import has no import and no verdict of its own (state new).
 */
export function statusOf(dir: string, entry: string | null = null): ScreenStatus {
  const cur = sourceSha(dir);
  let imp = readLastImport(dir);
  if (entry !== null && imp && importedEntry(dir, imp) !== entry) imp = null;
  const ver = imp ? readLastVerify(dir) : null;
  // a verdict counts only for the import it verified
  const current = !!imp && !!ver && ver.irSha === imp.irSha && ver.sourceSha === imp.sourceSha;
  let state: ScreenState;
  if (!imp) state = "new";
  else if (imp.sourceSha !== cur) state = "design-changed";
  else if (current) state = ver!.verdict === "pass" ? "verified" : ver!.verdict === "incomplete" ? "incomplete" : "failed";
  else state = "imported";
  return {
    state, sourceSha: cur, lastImportSha: imp?.sourceSha ?? null,
    verdict: current ? ver!.verdict : null,
    reportPath: current && fs.existsSync(ver!.reportPath) ? ver!.reportPath : null,
  };
}

/** Status of one screen folder under designRoot (by id or path), or of the page a path names in it. */
export function screenStatus(cfg: DesignUiConfig, screenId: string): ScreenStatus {
  const ref = resolveScreen(screenId, cfg.designRoot);
  return statusOf(ref.dir, ref.entry ? path.relative(ref.dir, ref.entry) : null);
}

export interface ScreenSummary extends ScreenStatus { screen: string; folder: string; entry: string | null; problem?: string }

/**
 * Screen folders with the screen id their pages name and their state; the page is the folder's last import, else the
 * page the folder resolves to. A folder whose pages name different screens, and a screen held by several folders, are
 * problems.
 */
export function listScreens(cfg: DesignUiConfig): ScreenSummary[] {
  const rows = screenFolders(cfg.designRoot).map((folder) => {
    const dir = path.join(cfg.designRoot, folder);
    let screen = folder, mixed: string | undefined, noEntry: string | undefined;
    try { screen = folderScreenId(dir, cfg.designRoot); } catch (e) { mixed = (e as Error).message; }
    let entry: string | null = importedEntry(dir, readLastImport(dir));
    if (entry === null) {
      try { entry = path.relative(dir, findEntry(dir, cfg.designRoot)); } catch (e) { noEntry = (e as Error).message; }
    }
    return { row: { screen, folder, entry, ...statusOf(dir) } as ScreenSummary, mixed, noEntry };
  });
  return rows.map(({ row, mixed, noEntry }) => {
    const others = rows.filter((o) => o.row !== row && !o.mixed && o.row.screen === row.screen).map((o) => o.row.folder);
    const twice = !mixed && others.length ? `screen ${row.screen} is also in ${others.join(", ")}: keep each screen's artboards in one folder` : undefined;
    const problem = mixed ?? twice ?? noEntry;
    return problem ? { ...row, problem } : row;
  });
}
