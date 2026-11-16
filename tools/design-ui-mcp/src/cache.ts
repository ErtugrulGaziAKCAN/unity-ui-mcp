import fs from "node:fs";
import path from "node:path";
import { BOOKKEEPING_DIR, screenFolders } from "./design.js";

/**
 * Disk use of the screens' bookkeeping (`<designRoot>/<screen>/.design-ui/`) and its cleanup, which the server runs by
 * itself: after every verify and import, and on design_ui_clean. Nobody deletes these folders by hand.
 *
 * What a screen keeps: its records (last-import.json, last-verify.json, lint-report.json and the run marker), the latest
 * export (import and verify read it), the latest report's pictures (`report/`) and verdict (`compare/verdict.json`), and
 * the newest `FAILED_RUNS_KEPT` failed runs, and the Unity captures a verify kept on request (`KEPT_CAPTURES_DIR`, the
 * verify's `keepCaptures`) until the next verify that gives a verdict, an import that exports the screen again, a later cleanup
 * over the budget or design_ui_clean (the verify's own cleanup keeps them and the export they are compared with). What goes: the Unity captures and difference images
 * of a finished verify (the report keeps crops of what failed), staging folders a run left behind, older failed runs and
 * `.tmp` files. When the designRoot's bookkeeping is larger than the budget (`cacheBudgetMB`), kept captures go first,
 * then the exports of the screens least recently imported or verified, oldest first; the next import or verify exports
 * them again. Never touched: the records, the design files, anything the server does not own, and a screen whose import
 * or verify is running.
 */
export const DEFAULT_CACHE_BUDGET_MB = 2048;
/** How many failed-<run> folders a screen keeps (the newest). */
export const FAILED_RUNS_KEPT = 3;
/** Where a verify keeps its Unity captures when asked to (`keepCaptures`), in the screen's bookkeeping. */
export const KEPT_CAPTURES_DIR = "kept-captures";
/** The marker an import or verify keeps in the screen's bookkeeping while it runs. */
export const BUSY_FILE = "busy.json";
/** A run marker older than this (or of a process that is gone) is left over from a crash. */
const BUSY_STALE_MS = 6 * 60 * 60 * 1000;

const MB = 1024 * 1024;

export interface Removal { screen: string; path: string; bytes: number; why: string }

export interface ScreenCache {
  /** The screen folder's name under designRoot. */
  folder: string;
  /** Bytes of its bookkeeping folder. */
  bytes: number;
  /** Bytes of its export (the part the budget can remove). */
  exportBytes: number;
  /** Bytes of the Unity captures a verify kept on request (the budget removes them before any export). */
  keptBytes: number;
  /** Last import or verify (ms since the epoch), else the bookkeeping folder's time. */
  lastUsed: number;
  /** An import or verify of it is running. */
  busy: boolean;
}

export interface CleanPlan {
  removals: Removal[];
  /** Bookkeeping bytes before and after the removals (all screens, or the one asked for), and the budget. */
  before: number;
  after: number;
  budget: number;
  screens: ScreenCache[];
}

/** Bytes under a path (files and folders, links not followed). */
export function bytesOf(p: string): number {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of fs.readdirSync(p)) n += bytesOf(path.join(p, name));
  return n;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The key of a screen folder's claim (and of a path the cleanup protects): its real path as it is on disk
 * (`realpathSync.native` gives the on-disk letter case on macOS and Windows, which open `login` for a folder `Login`), so
 * every spelling of one folder is one claim.
 */
function folderKey(screenDir: string): string {
  try { return fs.realpathSync.native(screenDir); } catch { return path.resolve(screenDir); }
}

/** Whether an import or verify of the screen folder is running (its marker names a live process, set in the last hours). */
export function isBusy(screenDir: string, now = Date.now()): boolean {
  const file = path.join(screenDir, BOOKKEEPING_DIR, BUSY_FILE);
  if (!fs.existsSync(file)) return false;
  return holds(folderKey(screenDir), file, readJson(file), now);
}

/** An import or verify that holds a screen folder. */
export interface BusyRun { what: string; pid: number; since: string }

/** A second import or verify of a screen folder while one runs: refused (one run per folder; they share its files). */
export class ScreenBusyError extends Error {
  constructor(readonly screen: string, readonly run: BusyRun | null) {
    super(`An import or verify of ${screen} is running; call it again when it ends.`);
  }
}

/** The runs this process holds, by screen folder (the marker file is the same claim across processes). */
const running = new Map<string, { what: string; since: string; token: string }>();
/** An unreadable marker younger than this is being written by its run (exclusive create, then the write). */
const BUSY_WRITE_MS = 10 * 1000;

/** Whether a marker found on disk belongs to a run that still holds the folder. */
function holds(key: string, file: string, m: any, now: number): boolean {
  if (!m) {
    // created exclusively a moment ago and not written yet, or a broken file a crash left
    try { return now - fs.statSync(file).mtimeMs < BUSY_WRITE_MS; } catch { return false; }
  }
  // this process knows its own runs: a marker with its pid that none of them holds is left over
  if (m.pid === process.pid) return running.get(key)?.token === m.token || [...running.values()].some((r) => r.token === m.token);
  const since = Date.parse(m.since ?? "");
  return alive(m.pid) && Number.isFinite(since) && now - since < BUSY_STALE_MS;
}

/**
 * Claims the screen folder for one import or verify and returns the function that ends the run. One run per folder: its
 * runs share the export, the staging folders and the records, and a finished run's cleanup would delete a running one's
 * captures. The claim is held in this process and as an exclusive marker file (`busy.json`, for the cleanup of other
 * server processes too); a marker of a process that is gone, or set more than BUSY_STALE_MS ago, is left over from a
 * crash and taken over. Throws ScreenBusyError while another run holds the folder.
 */
export function markBusy(screenDir: string, what: "import" | "verify"): () => void {
  const dir = path.join(screenDir, BOOKKEEPING_DIR), file = path.join(dir, BUSY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // the refusal names the folder as the caller wrote it (a symlink's own name, not its target's)
  const key = folderKey(screenDir), screen = path.basename(path.resolve(screenDir));
  const mine = running.get(key);
  if (mine) throw new ScreenBusyError(screen, { what: mine.what, pid: process.pid, since: mine.since });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const marker = { what, pid: process.pid, since: new Date().toISOString(), token };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(marker) + "\n", { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = readJson(file);
    if (attempt >= 3 || holds(key, file, held, Date.now())) {
      throw new ScreenBusyError(screen, held && typeof held.pid === "number" ? { what: String(held.what), pid: held.pid, since: String(held.since) } : null);
    }
    // left over: moved aside under a name of its own, so two processes taking over the same marker cannot both win; a marker
    // that turns out to be a live run's (written between the read and the move) goes back
    const aside = `${file}.${token}.old`;
    try { fs.renameSync(file, aside); } catch { continue; }
    const moved = readJson(aside);
    if (moved?.token !== held?.token && holds(key, aside, moved, Date.now())) {
      try { fs.linkSync(aside, file); } catch { /* another run claimed it meanwhile */ }
      fs.rmSync(aside, { force: true });
      throw new ScreenBusyError(screen, { what: String(moved.what), pid: moved.pid, since: String(moved.since) });
    }
    fs.rmSync(aside, { force: true });
  }
  running.set(key, { what, since: marker.since, token });
  return () => {
    if (running.get(key)?.token === token) running.delete(key);
    if (readJson(file)?.token === token) fs.rmSync(file, { force: true });
  };
}

const time = (s: unknown) => (typeof s === "string" ? Date.parse(s) : NaN);

/** The bookkeeping of one screen folder. */
export function screenCache(designRoot: string, folder: string, now = Date.now()): ScreenCache {
  const dir = path.join(designRoot, folder), book = path.join(dir, BOOKKEEPING_DIR);
  const imp = readJson(path.join(book, "last-import.json")), ver = readJson(path.join(book, "last-verify.json"));
  let lastUsed = Math.max(time(imp?.importedAt) || 0, time(ver?.verifiedAt) || 0);
  if (!lastUsed) { try { lastUsed = fs.statSync(book).mtimeMs; } catch { lastUsed = 0; } }
  return { folder, bytes: bytesOf(book), exportBytes: bytesOf(path.join(book, "export")), keptBytes: bytesOf(path.join(book, KEPT_CAPTURES_DIR)), lastUsed, busy: isBusy(dir, now) };
}

/** Every screen folder under designRoot that has bookkeeping. */
export function screenCaches(designRoot: string): ScreenCache[] {
  if (!fs.existsSync(designRoot)) return [];
  return screenFolders(designRoot).filter((f) => fs.existsSync(path.join(designRoot, f, BOOKKEEPING_DIR))).map((f) => screenCache(designRoot, f));
}

const KEPT_WHY = "Unity captures a verify kept on request (keepCaptures)";

/**
 * What one screen's bookkeeping holds that it does not keep (see the module summary): captures and difference images of
 * a finished verify, staging folders left behind, failed runs beyond the newest FAILED_RUNS_KEPT, `.tmp` files; with
 * `kept` (design_ui_clean), also the captures a verify kept on request. A busy screen keeps its staging folders and kept
 * captures (its run writes or replaces them now).
 */
export function screenRemovals(designRoot: string, folder: string, busy: boolean, kept = false): Removal[] {
  const book = path.join(designRoot, folder, BOOKKEEPING_DIR);
  if (!fs.existsSync(book)) return [];
  const out: Removal[] = [];
  const add = (p: string, why: string) => { if (fs.existsSync(p)) out.push({ screen: folder, path: p, bytes: bytesOf(p), why }); };
  if (!busy) {
    add(path.join(book, "unity"), "Unity captures of a finished verify (the report keeps crops of what failed)");
    add(path.join(book, "compare", "diff"), "difference images of a finished verify");
    add(path.join(book, "unity.next"), "captures of a run that did not finish");
    add(path.join(book, "compare.next"), "comparison of a run that did not finish");
    add(path.join(book, "report.next"), "report pictures of a run that did not finish");
    if (kept) add(path.join(book, KEPT_CAPTURES_DIR), KEPT_WHY);
    for (const name of fs.readdirSync(book)) if (name.endsWith(".tmp")) add(path.join(book, name), "unfinished write");
  }
  const failed = fs.readdirSync(book).filter((n) => n.startsWith("failed-")).sort();
  for (const old of failed.slice(0, Math.max(0, failed.length - FAILED_RUNS_KEPT))) add(path.join(book, old), `failed run beyond the newest ${FAILED_RUNS_KEPT}`);
  return out;
}

/**
 * The cleanup of designRoot's bookkeeping (or of one screen folder): each screen's own removals, then, while the
 * bookkeeping of all screens is larger than the budget, the captures verifies kept on request and after them the exports
 * of the screens least recently imported or verified, oldest first (never a busy screen's). `kept` (design_ui_clean):
 * kept captures go whatever the budget. With `folder`, only that screen's removals are listed (the budget still counts
 * every screen, so its export goes only when the whole designRoot is over budget and it is among the oldest).
 */
export function planClean(designRoot: string, budgetMB: number, folder?: string, opts: { kept?: boolean; protect?: readonly string[] } = {}): CleanPlan {
  const screens = screenCaches(designRoot);
  const budget = Math.round(budgetMB * MB);
  const removals: Removal[] = [];
  // what a run that just finished must keep (the captures it was asked to keep, and the export they are compared with): never
  // removed by its own cleanup
  const protect = (opts.protect ?? []).map(folderKey);
  const kept = (p: string) => protect.includes(folderKey(p));
  for (const s of screens) removals.push(...screenRemovals(designRoot, s.folder, s.busy, opts.kept === true).filter((r) => !kept(r.path)));
  const total = screens.reduce((a, s) => a + s.bytes, 0);
  let after = total - removals.reduce((a, r) => a + r.bytes, 0);
  const oldest = (a: ScreenCache, b: ScreenCache) => a.lastUsed - b.lastUsed || a.folder.localeCompare(b.folder);
  if (after > budget && opts.kept !== true) {
    for (const s of [...screens].filter((x) => !x.busy && x.keptBytes > 0).sort(oldest)) {
      if (after <= budget) break;
      const p = path.join(designRoot, s.folder, BOOKKEEPING_DIR, KEPT_CAPTURES_DIR);
      if (kept(p)) continue;
      removals.push({ screen: s.folder, path: p, bytes: s.keptBytes, why: `${KEPT_WHY}; the bookkeeping is over the ${budgetMB} MB budget` });
      after -= s.keptBytes;
    }
  }
  if (after > budget) {
    for (const s of [...screens].filter((x) => !x.busy && x.exportBytes > 0).sort(oldest)) {
      if (after <= budget) break;
      const p = path.join(designRoot, s.folder, BOOKKEEPING_DIR, "export");
      if (kept(p)) continue;
      removals.push({ screen: s.folder, path: p, bytes: s.exportBytes, why: `export of a screen not imported or verified since ${new Date(s.lastUsed).toISOString()} (the bookkeeping is over the ${budgetMB} MB budget; the next import or verify exports it again)` });
      after -= s.exportBytes;
    }
  }
  if (folder === undefined) return { removals, before: total, after, budget, screens };
  const mine = removals.filter((r) => r.screen === folder);
  const s = screens.find((x) => x.folder === folder);
  const before = s?.bytes ?? 0;
  return { removals: mine, before, after: before - mine.reduce((a, r) => a + r.bytes, 0), budget, screens: s ? [s] : [] };
}

/** Removes what a plan lists; returns what was removed and what could not be. */
export function applyClean(plan: CleanPlan): { removed: Removal[]; failed: { removal: Removal; error: string }[] } {
  const removed: Removal[] = [], failed: { removal: Removal; error: string }[] = [];
  for (const r of plan.removals) {
    // a run that started on the screen after the plan was made keeps what it writes
    const at = r.path.lastIndexOf(`${path.sep}${BOOKKEEPING_DIR}${path.sep}`);
    if (at > 0 && isBusy(r.path.slice(0, at))) { failed.push({ removal: r, error: "an import or verify of the screen started; left for the next cleanup" }); continue; }
    try {
      fs.rmSync(r.path, { recursive: true, force: true });
      removed.push(r);
      // the screen's report shows the export's design captures: say they are gone until the next verify
      if (path.basename(r.path) === "export") markReportExportPruned(path.dirname(path.dirname(r.path)));
      // kept captures: the record and the report no longer name them
      if (path.basename(r.path) === KEPT_CAPTURES_DIR) markKeptCapturesRemoved(path.dirname(path.dirname(r.path)), r.why);
    } catch (e) { failed.push({ removal: r, error: (e as Error).message }); }
  }
  return { removed, failed };
}

const PRUNED_NOTE = "Export pruned; re-run verify for images";

/** Puts a note at the top of `<screenDir>/report.html` (once): its design captures went with the export. */
function markReportExportPruned(screenDir: string): void {
  const file = path.join(screenDir, "report.html");
  let html: string;
  try { html = fs.readFileSync(file, "utf8"); } catch { return; }
  if (html.includes(PRUNED_NOTE)) return;
  const note = `<p class="export-pruned" style="padding:8px 12px;background:#fff3cd;color:#3d2f00;border:1px solid #e0c36a">${PRUNED_NOTE}: ` +
    "the cleanup removed this screen's export to keep the bookkeeping under cacheBudgetMB, so the design captures this report shows are gone " +
    "(the pictures it kept of failing captures stay). design_ui_verify exports and reports the screen again.</p>";
  const at = html.search(/<body[^>]*>/i);
  const out = at < 0 ? note + html : html.replace(/<body[^>]*>/i, (m) => m + note);
  try { fs.writeFileSync(`${file}.tmp`, out); fs.renameSync(`${file}.tmp`, file); } catch { /* the report stays as it was */ }
}

const KEPT_NOTE = "Kept captures removed";

/**
 * Removes a screen's kept captures outside a cleanup (an import that exported the screen again: they were taken against
 * the goldens it replaced), and says so in the record and the report. Returns whether there were any.
 */
export function dropKeptCaptures(screenDir: string, why: string): boolean {
  const dir = path.join(screenDir, BOOKKEEPING_DIR, KEPT_CAPTURES_DIR);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  markKeptCapturesRemoved(screenDir, why);
  return true;
}

/**
 * After a cleanup removed a screen's kept captures: `last-verify.json` drops `keptCaptures`, and the report says so at its
 * top (once), with why.
 */
function markKeptCapturesRemoved(screenDir: string, why: string): void {
  const record = path.join(screenDir, BOOKKEEPING_DIR, "last-verify.json");
  const v = readJson(record);
  if (v && typeof v === "object" && "keptCaptures" in v) {
    delete v.keptCaptures;
    try { fs.writeFileSync(`${record}.tmp`, JSON.stringify(v, null, 2) + "\n"); fs.renameSync(`${record}.tmp`, record); } catch { /* the record stays */ }
  }
  const file = path.join(screenDir, "report.html");
  let html: string;
  try { html = fs.readFileSync(file, "utf8"); } catch { return; }
  if (html.includes(KEPT_NOTE)) return;
  const note = `<p class="kept-removed" style="padding:8px 12px;background:#fff3cd;color:#3d2f00;border:1px solid #e0c36a">${KEPT_NOTE}: ` +
    `the cleanup removed the Unity captures this verify kept (${why.replace(/[<&>]/g, "")}).</p>`;
  const out = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + note) : note + html;
  try { fs.writeFileSync(`${file}.tmp`, out); fs.renameSync(`${file}.tmp`, file); } catch { /* the report stays as it was */ }
}

/** `12.3 MB` */
export const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
