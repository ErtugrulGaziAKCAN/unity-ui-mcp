/**
 * The whole browser side of the exporter in one run (spec §7, §14): load the design, lint it, extract the IR (with
 * baked effects), capture the golden matrix and write the output folder. One browser serves every step.
 *
 * The output folder is always fresh: everything is written to `<out>.tmp-<random>` and renamed over `<out>` at the
 * end, so a failure leaves the previous export untouched and no half-written folder behind.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { BOXES_FILE } from "./boxes/file.js";
import { CHROMIUM_ARGS, launchChromium } from "./browser.js";
import { CaptureFailed, captureMatrix, volumeLines, type HiddenJob } from "./capture/capture.js";
import { EXPORT_FAILURE_FILE, failedExportDir } from "./failed-export.js";
import { buildIr } from "./extract/tree.js";
import { stableStringify } from "./ir/stableStringify.js";
import { IR_VERSION } from "./ir/types.js";
import { validateIr } from "./ir/validate.js";
import { readKit, type KitConfig } from "./kit.js";
import { collectSnapshot, lint, type Finding } from "./lint/index.js";
import { openDesign } from "./load.js";
import { readScreenContract, type ContractLoad } from "./contract.js";

export interface ExportResult {
  /** false when lint found errors: only lint-report.json was written. */
  ok: boolean;
  findings: Finding[];
  outDir: string;
  /** true when the design, kit and tool hashes matched the previous export, which was left as it is. */
  skipped?: boolean;
  /** Milliseconds per step: load, lint, extract, bake, capture, write (zeros when skipped). */
  timings: Record<string, number>;
  /** Wall-clock milliseconds of the whole run, reported apart from the steps. */
  totalMs: number;
  /** Non-fatal problems (e.g. the replaced export folder could not be deleted). */
  warnings: string[];
  /**
   * Capture jobs whose elements no state, class context or written-out repeat item shows (goldens/matrix.json
   * `hidden`): they have no golden, so a verify of this export is incomplete until the design shows them somewhere.
   */
  hidden: HiddenJob[];
  /** The screen contract read beside the design (state "absent" when there is none). */
  contract: ContractLoad;
}

/** The hidden jobs an export's goldens/matrix.json lists (none when it has none or cannot be read). */
function hiddenOf(outDir: string): HiddenJob[] {
  const m = readJsonIf<{ hidden?: HiddenJob[] }>(path.join(outDir, "goldens", "matrix.json"));
  return Array.isArray(m?.hidden) ? m!.hidden.filter((h) => h && typeof h.name === "string") : [];
}

export interface ExportOptions {
  /** Shared browser (the MCP server keeps one warm); never closed here. Without it one is launched and closed. */
  browser?: Browser | (() => Promise<Browser>);
  /** Export even when the design and kit are unchanged. */
  force?: boolean;
  /** Viewports captured at the same time. */
  concurrency?: number;
  /** Gets the lines the export prints while it runs: before capturing, the number of captures and the estimated size of their boxes. */
  log?: (line: string) => void;
  /**
   * When set and lint finds errors, the lint report goes to this file and the previous export folder is left as it
   * is (instead of being replaced by a lint-only folder). A successful export removes the file.
   */
  lintReportFile?: string;
}

/** `notes` counts the info findings, which are neither errors nor warnings. */
export interface LintOutcome { findings: Finding[]; errors: number; notes: number }

/** The value export-report.json records for a screen contract: its content hash, or "none" without one. */
const contractShaOf = (c: ContractLoad): string => (c.state === "absent" ? "none" : c.sha);
const countOf = (findings: Finding[], severity: Finding["severity"]): number => findings.filter((f) => f.severity === severity).length;

const REPORT_FILE = "report.html";
/** Written into every folder this exporter creates; the only thing that marks a folder as a previous export. */
export const MARKER_FILE = ".design-export.json";
const MARKER = { generator: "design-export", format: 1 };
export const hasMarker = (dir: string): boolean => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), "utf8")) as { generator?: string; format?: number };
    return m.generator === MARKER.generator && m.format === MARKER.format;
  } catch { return false; }
};
const OUTPUTS = ["screen.ir.json", "lint-report.json", "fixtures/sample-data.json", "goldens/matrix.json", `goldens/${BOXES_FILE}`];
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
/** The top-level `irVersion` of an IR file (only the root object has that key; a text's quotes are escaped), or null. */
const irVersionOf = (file: string): number | null => {
  try { const m = /"irVersion"\s*:\s*(\d+)/.exec(fs.readFileSync(file, "utf8")); return m ? Number(m[1]) : null; } catch { return null; }
};
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const rounded = (n: number) => Math.round(n * 10) / 10;

/** The design page: the one `.html` / `.dc.html` of a folder, or the given file. */
export function findDesignHtml(input: string): string {
  const p = path.resolve(input);
  if (!fs.existsSync(p)) throw new Error(`design not found: ${p}`);
  if (fs.statSync(p).isFile()) return p;
  const pages = fs.readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.html$/i.test(d.name) && d.name.toLowerCase() !== REPORT_FILE)
    .map((d) => d.name).sort();
  if (pages.length === 0) throw new Error(`no .html or .dc.html file in ${p}`);
  if (pages.length > 1) throw new Error(`${p} has more than one HTML file (${pages.join(", ")}); pass the file to export`);
  return path.join(p, pages[0]);
}

// ---- hashing -----------------------------------------------------------------------------------------------------

const fileSha = (file: string): string => {
  try {
    const st = fs.statSync(file); // follows symlinks
    return st.isFile() ? sha256(fs.readFileSync(file)) : "not-a-file";
  } catch { return "missing"; }
};

const REF_PATTERNS: RegExp[] = [
  /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi,
  /@import\s+(?:"([^"]*)"|'([^']*)')/gi,
];

/** Relative references found in markup or CSS text (srcset candidates included); remote and data: references are skipped. */
function referencesIn(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    let r = raw.trim().replace(/[?#].*$/, "");
    if (!r || r.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return;
    try { r = decodeURIComponent(r); } catch { /* keep as written */ }
    out.add(r);
  };
  for (const re of REF_PATTERNS) for (const m of text.matchAll(re)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const cand of (m[1] ?? m[2]).split(",")) add(cand.trim().split(/\s+/)[0]);
  }
  return Array.from(out);
}

/**
 * Hash of what one design page reads: the page itself, a blobs.json next to it, and the files it references
 * (stylesheets are followed). Referenced files that are missing count as such, so adding one changes the hash.
 * Symlinks are followed; references that leave the design folder are not read.
 */
export function designHash(htmlPath: string): string {
  const designDir = path.dirname(htmlPath);
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (abs: string, followRefs: boolean) => {
    const rel = path.relative(designDir, abs).split(path.sep).join("/");
    if (seen.has(rel)) return;
    seen.add(rel);
    lines.push(`${rel}\0${fileSha(abs)}`);
    if (!followRefs || !fs.existsSync(abs)) return;
    let text: string;
    try { text = fs.readFileSync(abs, "utf8"); } catch { return; }
    for (const ref of referencesIn(text)) {
      if (ref.startsWith("/__kit/")) continue;
      const target = path.resolve(ref.startsWith("/") ? path.join(designDir, ref) : path.join(path.dirname(abs), ref));
      if (target !== designDir && !target.startsWith(designDir + path.sep)) continue;
      visit(target, /\.(css|svg)$/i.test(target));
    }
  };
  visit(htmlPath, true);
  const blobs = path.join(designDir, "blobs.json");
  if (!seen.has("blobs.json")) visit(blobs, false);
  return sha256(lines.sort().join("\n"));
}

function folderHash(dir: string): string {
  const lines: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } }
      if (isDir) walk(p, r); else lines.push(`${r}\0${fileSha(p)}`);
    }
  };
  walk(dir, "");
  return sha256(lines.sort().join("\n"));
}

/** Hash of the effective kit: its configuration as loaded plus every file in its folder. */
export function kitHash(kit: KitConfig): string {
  const { dir: _dir, ...config } = kit;
  return sha256(`${JSON.stringify(config)}\n${folderHash(kit.dir)}`);
}

/**
 * Raised whenever the extraction writes something else for the same design and kit (an export of an older extractor is then
 * made again instead of reused). 2: keyed inline texts match their text style on line height too (caption 20/28 and label
 * 20/24 share size and weight). 3: the goldens record where Chromium cuts an ellipsized line (boxes `ellipsis`, decisions
 * D-146 and D-147) and its scale is exactly 1 without a transform; an export of revision 2 has no such record, so the
 * comparison judged its ellipsized lines without the glyph check or the scaled-class allowance. 4: an image bind's
 * sample is the image its item shows (`$image`, written to assets/ for every written-out item); revision 3 wrote an empty
 * text, so the Unity capture showed the template's image in every item.
 */
export const EXTRACT_REVISION = 4;

/**
 * What the tool hash covers: exporter package version, extraction revision, the IR schema, the goldens' record schema
 * (boxes: a field the comparison reads is new data an older export lacks) and the Chromium build and arguments.
 */
export function toolHashInputs(): string[] {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const schema = fs.readFileSync(new URL("./ir/schema.json", import.meta.url));
  const boxes = fs.readFileSync(new URL("./boxes/schema.json", import.meta.url));
  let chromiumBuild = "unknown";
  try { chromiumBuild = chromium.executablePath(); } catch { /* not installed: the export fails later with a clear error */ }
  return [pkg.version, `extract ${EXTRACT_REVISION}`, sha256(schema), `boxes ${sha256(boxes)}`, chromiumBuild, CHROMIUM_ARGS.join(" "), process.platform, process.arch];
}

/** Hash of the tool that makes the export (toolHashInputs). */
export function toolHash(): string {
  return sha256(toolHashInputs().join("\n"));
}

// ---- output folder safety ----------------------------------------------------------------------------------------

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Refuses an output folder that is, contains or sits on something that must not be replaced. */
export function assertSafeOut(outDir: string, designPath: string): void {
  const out = real(path.resolve(outDir));
  const design = real(designPath);
  const refuse = (why: string) => { throw new Error(`refusing to use ${outDir} as the output folder: ${why}. Choose a new or previous-export folder (for example <design>/.design-ui/export).`); };
  if (out === path.parse(out).root) refuse("it is a filesystem root");
  if (out === real(os.homedir())) refuse("it is the home folder");
  const cwd = real(process.cwd());
  if (isInside(cwd, out)) refuse("it is the current folder or contains it");
  if (isInside(design, out)) refuse("it is the design or contains the design");
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) refuse("it exists and is not a folder");
    const entries = fs.readdirSync(out);
    if (entries.length && !hasMarker(out)) {
      refuse(`it is a non-empty folder that is not a previous export (no ${MARKER_FILE} written by design-export)`);
    }
  }
}

const readJsonIf = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
};

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** `<out>.lock` holding the pid; a lock whose process is gone is stale and taken over. Returns the release function. */
function acquireLock(outDir: string): () => void {
  const file = `${outDir}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* left for the next run to take over */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (alive(pid)) throw new Error(`another export into ${outDir} is running (pid ${pid}); wait for it to finish`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`could not lock ${outDir} (${file})`);
}

/**
 * Under the lock nothing else writes beside `out`: restore the newest `.tmp-old-*` when `out` is missing (a crash between
 * the two renames), then remove every other `<out>.tmp-*` left by a crashed run.
 */
function recoverAndSweep(outDir: string, warnings: string[]): void {
  const parent = path.dirname(outDir), base = path.basename(outDir);
  if (!fs.existsSync(parent)) return;
  // only folders this exporter made: the exact temp name shape, and its marker (or nothing in it yet)
  const shape = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tmp-(old-)?[0-9a-f]{8}$`);
  const ours = (p: string) => { try { return fs.statSync(p).isDirectory() && (hasMarker(p) || fs.readdirSync(p).length === 0); } catch { return false; } };
  const stale = fs.readdirSync(parent).filter((n) => shape.test(n)).map((n) => path.join(parent, n)).filter(ours);
  if (!fs.existsSync(outDir)) {
    const olds = stale.filter((p) => path.basename(p).startsWith(`${base}.tmp-old-`) && hasMarker(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (olds.length) {
      fs.renameSync(olds[0], outDir);
      stale.splice(stale.indexOf(olds[0]), 1);
      warnings.push(`restored the previous export from ${path.basename(olds[0])}`);
    }
  }
  for (const p of stale) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { warnings.push(`could not remove ${p}`); } }
}

/**
 * Replaces `out` with `fresh` (a sibling folder): the old folder goes aside first and comes back if the second rename
 * fails. Deleting the old folder afterwards is best effort; a leftover is swept by the next run.
 */
function replaceDir(fresh: string, out: string, warnings: string[]): void {
  const aside = fs.existsSync(out) ? `${out}.tmp-old-${crypto.randomBytes(4).toString("hex")}` : null;
  if (aside) fs.renameSync(out, aside);
  try { fs.renameSync(fresh, out); } catch (e) {
    if (aside) {
      try { fs.renameSync(aside, out); } catch (restore) {
        throw new Error(`${(e as Error).message}; restoring the previous export also failed: ${(restore as Error).message} (it is kept in ${aside})`);
      }
    }
    throw e;
  }
  if (aside) {
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch (e) { warnings.push(`the new export is in place, but the old one could not be deleted (${aside}): ${(e as Error).message}`); }
  }
}

const resolveKit = (kit: string | KitConfig): KitConfig => {
  if (typeof kit !== "string") return kit;
  if (!fs.existsSync(path.join(kit, "kit.config.json"))) throw new Error(`design kit not found: ${path.join(kit, "kit.config.json")} is missing`);
  return readKit(kit);
};

async function withBrowser<T>(given: Browser | (() => Promise<Browser>) | undefined, fn: (b: Browser) => Promise<T>): Promise<T> {
  if (typeof given === "function") return fn(await given());
  if (given) return fn(given);
  const b = await launchChromium();
  try { return await fn(b); } finally { await b.close().catch(() => {}); }
}

/** Lints a design page (no output written). */
export async function lintScreen(input: string, kitIn: string | KitConfig, opts: { browser?: Browser } = {}): Promise<LintOutcome> {
  const htmlPath = findDesignHtml(input);
  const kit = resolveKit(kitIn);
  return withBrowser(opts.browser, async (browser) => {
    const d = await openDesign(htmlPath, kit, kit.reference, browser);
    try {
      const findings = await lint(d, kit, undefined, readScreenContract(path.dirname(htmlPath)));
      return { findings, errors: countOf(findings, "error"), notes: countOf(findings, "info") };
    } finally { await d.close(); }
  });
}

export async function exportScreen(input: string, kitIn: string | KitConfig, outDirIn: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const t0 = performance.now();
  const htmlPath = findDesignHtml(input);
  const outDir = path.resolve(outDirIn);
  assertSafeOut(outDir, htmlPath); // before anything is read or written
  const kit = resolveKit(kitIn);
  const warnings: string[] = [];
  const contract = readScreenContract(path.dirname(htmlPath));
  const contractSha = contractShaOf(contract);
  const release = acquireLock(outDir);
  try {
    recoverAndSweep(outDir, warnings);
    const sourceSha = designHash(htmlPath);
    const kitSha = kitHash(kit);
    const toolSha = toolHash();

    // unchanged design, kit and tool, and an IR of this version: the previous export stands. The tool hash covers the IR
    // schema, so an export of another IR version has another hash; the IR's own version is read as well, because a server
    // process older than its clone's files hashes the new schema while it writes its own IR version
    if (!opts.force) {
      const prev = readJsonIf<{ ok: boolean; sourceSha: string; kitSha: string; toolSha: string; contractSha?: string; source: string }>(path.join(outDir, "export-report.json"));
      if (prev?.ok && prev.sourceSha === sourceSha && prev.kitSha === kitSha && prev.toolSha === toolSha && prev.contractSha === contractSha && prev.source === path.basename(htmlPath)
        && OUTPUTS.every((f) => fs.existsSync(path.join(outDir, f))) && irVersionOf(path.join(outDir, "screen.ir.json")) === IR_VERSION) {
        const lintReport = readJsonIf<{ findings: Finding[] }>(path.join(outDir, "lint-report.json"));
        dropFailed(outDir, warnings);
        return {
          ok: true, skipped: true, findings: lintReport?.findings ?? [], outDir, warnings, hidden: hiddenOf(outDir), contract,
          timings: { load: 0, lint: 0, extract: 0, bake: 0, capture: 0, write: 0 }, totalMs: ms(t0),
        };
      }
    }

    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const fresh = `${outDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, MARKER_FILE), JSON.stringify(MARKER) + "\n");
    // a failure while capturing keeps the folder (the captures finished so far) as <outDir>.failed
    let capturing = false;
    try {
      const result = await withBrowser(opts.browser, async (browser) => {
        const timings: Record<string, number> = { load: 0, lint: 0, extract: 0, bake: 0, capture: 0, write: 0 };
        let t = performance.now();
        const lap = (k: string) => { const n = performance.now(); timings[k] = rounded(timings[k] + ms(t)); t = n; };

        const d = await openDesign(htmlPath, kit, kit.reference, browser);
        try {
          lap("load");
          const snapshot = await collectSnapshot(d.page, d.cdp, kit);
          const findings = await lint(d, kit, snapshot, contract);
          lap("lint");
          const errors = findings.filter((f) => f.severity === "error");
          const notes = countOf(findings, "info");
          const lintJson = stableStringify({
            source: path.basename(htmlPath), errors: errors.length, warnings: findings.length - errors.length - notes, notes, findings,
          });
          fs.writeFileSync(path.join(fresh, "lint-report.json"), lintJson);
          lap("write");
          if (errors.length) return { ok: false, findings, timings, lintJson, hidden: [] as HiddenJob[] };

          const build = await buildIr(d, snapshot, kit, fresh, htmlPath);
          const problems = validateIr(build.ir);
          if (problems.length) throw new Error(`the extracted IR is not valid: ${problems.slice(0, 5).join("; ")}`);
          const bake = Object.entries(build.timings).filter(([k]) => /^bake/i.test(k)).reduce((a, [, v]) => a + v, 0);
          lap("extract");
          timings.bake = rounded(bake);
          timings.extract = rounded(Math.max(0, timings.extract - bake));

          fs.mkdirSync(path.join(fresh, "assets"), { recursive: true });
          fs.mkdirSync(path.join(fresh, "fixtures"), { recursive: true });
          fs.writeFileSync(path.join(fresh, "screen.ir.json"), stableStringify(build.ir));
          fs.writeFileSync(path.join(fresh, "fixtures", "sample-data.json"), stableStringify(build.fixtures));
          lap("write");

          capturing = true;
          const matrix = await captureMatrix(htmlPath, kit, build.ir, build.elements, path.join(fresh, "goldens"), {
            browser, open: [d], concurrency: opts.concurrency, log: opts.log,
          });
          capturing = false;
          lap("capture");
          const volume = volumeLines(matrix.volume).warning;
          if (volume) warnings.push(volume);

          fs.writeFileSync(path.join(fresh, "export-report.json"), stableStringify({
            ok: true, source: path.basename(htmlPath), sourceSha, kitSha, toolSha, contractSha, screen: build.ir.screen,
            warnings: findings.length - notes, notes, captures: matrix.jobs.length, hidden: matrix.hidden.length, timings, totalMs: ms(t0),
            detail: { extract: build.timings, capture: matrix.timings },
          }));
          lap("write");
          return { ok: true, findings, timings, lintJson, hidden: matrix.hidden };
        } finally { await d.close(); }
      });
      if (!result.ok && opts.lintReportFile) {
        // keep the previous export; the lint result goes next to it
        fs.rmSync(fresh, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(opts.lintReportFile), { recursive: true });
        fs.writeFileSync(opts.lintReportFile, result.lintJson);
        return { ok: false, findings: result.findings, outDir, timings: result.timings, totalMs: ms(t0), warnings, hidden: [], contract };
      }
      replaceDir(fresh, outDir, warnings);
      if (result.ok && opts.lintReportFile) fs.rmSync(opts.lintReportFile, { force: true });
      if (result.ok) dropFailed(outDir, warnings);
      return { ok: result.ok, findings: result.findings, outDir, timings: result.timings, totalMs: ms(t0), warnings, hidden: result.hidden, contract };
    } catch (e) {
      if (capturing) throw keepFailed(fresh, outDir, e);
      fs.rmSync(fresh, { recursive: true, force: true });
      throw e;
    }
  } finally { release(); }
}

/**
 * Keeps the folder of an export whose capture failed as `<outDir>.failed` (failed-export.ts), replacing an earlier one,
 * with export-failure.json saying what failed, how many captures were finished and each finished capture's PNG file
 * (`files`: name → file without .png, as matrix.json's `file`, which the folder does not have); returns the error naming
 * the folder. When it cannot be kept, the folder goes and the error says so.
 */
function keepFailed(fresh: string, outDir: string, e: unknown): Error {
  const failed = failedExportDir(outDir);
  const message = e instanceof Error ? e.message : String(e);
  try {
    fs.writeFileSync(path.join(fresh, EXPORT_FAILURE_FILE), stableStringify({
      ok: false, stage: "capture", error: message,
      ...(e instanceof CaptureFailed ? { doing: e.doing, finished: e.finished, captures: e.total, files: e.files } : {}),
    }));
    fs.rmSync(failed, { recursive: true, force: true });
    fs.renameSync(fresh, failed);
  } catch (keep) {
    fs.rmSync(fresh, { recursive: true, force: true });
    return new Error(`${message} (keeping the finished captures failed: ${(keep as Error).message})`, { cause: e });
  }
  return new Error(`${message}; the finished captures are kept in ${failed}`, { cause: e });
}

/** A successful export of `outDir` removes the folder an earlier failed capture kept beside it. */
function dropFailed(outDir: string, warnings: string[]): void {
  const failed = failedExportDir(outDir);
  try { fs.rmSync(failed, { recursive: true, force: true }); } catch (e) { warnings.push(`could not remove ${failed}: ${(e as Error).message}`); }
}
