/**
 * The whole browser side of the exporter in one run (spec §7, §14): load the design, lint it, extract the IR (with
 * baked effects), capture the golden matrix and write the output folder. One browser serves every step.
 *
 * The output folder is always fresh: everything is written to `<out>.tmp-<random>` and renamed over `<out>` at the
 * end, so a failure leaves the previous export untouched and no half-written folder behind.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { captureMatrix } from "./capture/capture.js";
import { buildIr } from "./extract/tree.js";
import { stableStringify } from "./ir/stableStringify.js";
import { validateIr } from "./ir/validate.js";
import { readKit, type KitConfig } from "./kit.js";
import { collectSnapshot, lint, type Finding } from "./lint/index.js";
import { openDesign } from "./load.js";

export interface ExportResult {
  /** false when lint found errors: only lint-report.json was written. */
  ok: boolean;
  findings: Finding[];
  outDir: string;
  /** true when the design and kit hashes matched the previous export, which was left as it is. */
  skipped?: boolean;
  /** Milliseconds per step: load, lint, extract, bake, capture, write, total (zeros when skipped). */
  timings: Record<string, number>;
}

export interface ExportOptions {
  /** Shared browser (the MCP server keeps one warm); never closed here. Without it one is launched and closed. */
  browser?: Browser;
  /** Export even when the design and kit are unchanged. */
  force?: boolean;
  /** Viewports captured at the same time. */
  concurrency?: number;
}

export interface LintOutcome { findings: Finding[]; errors: number }

const REPORT_FILE = "report.html";
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
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

/** Hash of every non-hidden file of a folder (the report file and `skip` excluded). */
function folderHash(dir: string, skip: string[] = []): string {
  const lines: string[] = [];
  const skips = skip.map((s) => path.resolve(s));
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const p = path.join(abs, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      if (!rel && d.name.toLowerCase() === REPORT_FILE) continue;
      if (skips.includes(p)) continue;
      if (d.isDirectory()) walk(p, r);
      else if (d.isFile()) lines.push(`${r}\0${sha256(fs.readFileSync(p))}`);
    }
  };
  walk(dir, "");
  return sha256(lines.sort().join("\n"));
}

const readJsonIf = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
};

/** Replaces `out` with `fresh` (a sibling folder): the old folder goes aside first and is restored if the rename fails. */
function replaceDir(fresh: string, out: string): void {
  const aside = fs.existsSync(out) ? `${out}.tmp-old-${crypto.randomBytes(4).toString("hex")}` : null;
  if (aside) fs.renameSync(out, aside);
  try { fs.renameSync(fresh, out); } catch (e) {
    if (aside) fs.renameSync(aside, out);
    throw e;
  }
  if (aside) fs.rmSync(aside, { recursive: true, force: true });
}

const resolveKit = (kit: string | KitConfig): KitConfig => {
  if (typeof kit !== "string") return kit;
  if (!fs.existsSync(path.join(kit, "kit.config.json"))) throw new Error(`design kit not found: ${path.join(kit, "kit.config.json")} is missing`);
  return readKit(kit);
};

/** Hash of the kit's files (config, fonts, tokens, text styles); changes whenever anything the export reads changes. */
export function kitHash(kit: KitConfig): string {
  return folderHash(kit.dir);
}

async function withBrowser<T>(given: Browser | undefined, fn: (b: Browser) => Promise<T>): Promise<T> {
  if (given) return fn(given);
  const b = await chromium.launch();
  try { return await fn(b); } finally { await b.close().catch(() => {}); }
}

/** Lints a design page (no output written). */
export async function lintScreen(input: string, kitIn: string | KitConfig, opts: { browser?: Browser } = {}): Promise<LintOutcome> {
  const htmlPath = findDesignHtml(input);
  const kit = resolveKit(kitIn);
  return withBrowser(opts.browser, async (browser) => {
    const d = await openDesign(htmlPath, kit, kit.reference, browser);
    try {
      const findings = await lint(d, kit);
      return { findings, errors: findings.filter((f) => f.severity === "error").length };
    } finally { await d.close(); }
  });
}

export async function exportScreen(input: string, kitIn: string | KitConfig, outDirIn: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const t0 = performance.now();
  const htmlPath = findDesignHtml(input);
  const designDir = path.dirname(htmlPath);
  const kit = resolveKit(kitIn);
  const outDir = path.resolve(outDirIn);
  const sourceSha = folderHash(designDir, [outDir]);
  const kitSha = kitHash(kit);

  // unchanged design and kit: the previous export stands
  if (!opts.force) {
    const prev = readJsonIf<{ ok: boolean; sourceSha: string; kitSha: string; source: string }>(path.join(outDir, "export-report.json"));
    if (prev?.ok && prev.sourceSha === sourceSha && prev.kitSha === kitSha && prev.source === path.basename(htmlPath)
      && fs.existsSync(path.join(outDir, "screen.ir.json"))) {
      const lintReport = readJsonIf<{ findings: Finding[] }>(path.join(outDir, "lint-report.json"));
      return {
        ok: true, skipped: true, findings: lintReport?.findings ?? [], outDir,
        timings: { load: 0, lint: 0, extract: 0, bake: 0, capture: 0, write: 0, total: ms(t0) },
      };
    }
  }

  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const fresh = `${outDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(fresh);
  try {
    const result = await withBrowser(opts.browser, async (browser) => {
      const timings: Record<string, number> = { load: 0, lint: 0, extract: 0, bake: 0, capture: 0, write: 0, total: 0 };
      let t = performance.now();
      const lap = (k: string) => { const n = performance.now(); timings[k] = rounded(timings[k] + ms(t)); t = n; };

      const d = await openDesign(htmlPath, kit, kit.reference, browser);
      try {
        lap("load");
        const snapshot = await collectSnapshot(d.page, d.cdp, kit);
        const findings = await lint(d, kit, snapshot);
        lap("lint");
        const errors = findings.filter((f) => f.severity === "error");
        fs.writeFileSync(path.join(fresh, "lint-report.json"), stableStringify({
          source: path.basename(htmlPath), errors: errors.length, warnings: findings.length - errors.length, findings,
        }));
        lap("write");
        if (errors.length) {
          timings.total = ms(t0);
          return { ok: false, findings, timings };
        }

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

        const matrix = await captureMatrix(htmlPath, kit, build.ir, build.elements, path.join(fresh, "goldens"), {
          browser, open: [d], concurrency: opts.concurrency,
        });
        lap("capture");

        timings.total = ms(t0);
        fs.writeFileSync(path.join(fresh, "export-report.json"), stableStringify({
          ok: true, source: path.basename(htmlPath), sourceSha, kitSha, screen: build.ir.screen,
          warnings: findings.length, captures: matrix.jobs.length, timings,
          detail: { extract: build.timings, capture: matrix.timings },
        }));
        lap("write");
        timings.total = ms(t0);
        return { ok: true, findings, timings };
      } finally { await d.close(); }
    });
    replaceDir(fresh, outDir);
    return { ...result, outDir };
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
}
