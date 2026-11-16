import { Command, CommanderError } from "commander";
import path from "node:path";
import { compareScreen, readThresholds, summarizeIssues } from "./compare/compare.js";
import { writeReport, writeVerdict } from "./compare/report.js";
import { contractBrief } from "./contract-brief.js";
import { CONTRACT_FILE, readScreenContract } from "./contract.js";
import { exportScreen, lintScreen } from "./export.js";
import { readKit } from "./kit.js";
import { buildKit } from "./kit/build.js";
import { writeClaudeDesignSystem } from "./kit/claudeDesignSystem.js";
import { KEEP_BACKUPS, upgradeKit } from "./kit/upgrade.js";
import { DEFAULT_TITLE } from "./kit/rulesDoc.js";
import type { Finding } from "./lint/index.js";

export interface CliIo { out(s: string): void; err(s: string): void }

const USAGE = `Usage: design-export <command> [options]

Commands:
  lint <designDir> --kit <kitDir>                Lint a Claude Design HTML screen
  export <designDir> --kit <kitDir> --out <dir>  Export a screen: IR, goldens, assets, sample data
  contract brief <designDir> --kit <kitDir>      Print the design brief of the screen's screen.contract.json
  compare <exportDir> --unity <captureDir> --report <file.html>
                                                 Compare Unity captures with the goldens; write the report and verdict.json
  kit build <kitDir> [--check]                   Regenerate base.css, RULES.md and the base block of kit pages;
                                                 check that the font tokens name families fonts.css declares
  kit upgrade <kitDir> [--from <cloneKit>] [--dry-run]
                                                 Bring a project's kit to this clone's kit: the clone's base, rules,
                                                 components, text styles and config keys; the project's fonts, own and
                                                 changed tokens, locales, own keys, styles and extra viewports kept;
                                                 changed files backed up into <kitDir>/.backup/; kit build and --check
  kit claude <kitDir> <outDir> [--title <name>] [--force] [--all-faces]
                                                 Write the kit as a Claude Design System folder (<outDir>/project): the
                                                 font faces the text styles and font tokens reach (--all-faces: every
                                                 face), no file over the Design System's 15 MiB cap

Exit codes: 0 ok (compare: every capture passes), 1 lint errors (compare: a capture fails or is not run;
kit build --check: generated files are stale; kit build: a --font-* token names a family fonts.css does not
declare; kit upgrade: the merged kit does not build, nothing written), 2 usage or internal error.
`;

const line = (f: Finding) => `${f.severity.padEnd(7)} ${f.ruleId} ${f.path}: ${f.detail}${f.fix ? `\n        fix: ${f.fix}` : ""}`;

/** Runs the command line; returns the exit code (0 ok, 1 lint errors, 2 usage or internal error). */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = new Command().name("design-export").exitOverride().configureOutput({
    writeOut: (s) => io.out(s), writeErr: (s) => io.err(s),
  });
  program.helpOption("-h, --help", "Show this help");
  let code = 0;
  const guard = (fn: (...a: never[]) => Promise<number>) => async (...a: never[]) => {
    try { code = await fn(...a); } catch (e) {
      io.err(`design-export: ${(e as Error).message}\n`);
      code = 2;
    }
  };

  program.command("lint").allowExcessArguments(false).argument("<designDir>").requiredOption("--kit <kitDir>").description("Lint a design")
    .action(guard(async (dir: string, o: { kit: string }) => {
      const r = await lintScreen(dir, path.resolve(o.kit));
      for (const f of r.findings) io.out(line(f) + "\n");
      const warnings = r.findings.length - r.errors - r.notes;
      io.out(`${r.errors} error${r.errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${r.notes} note${r.notes === 1 ? "" : "s"}\n`);
      return r.errors ? 1 : 0;
    }) as never);

  program.command("export").allowExcessArguments(false).argument("<designDir>").requiredOption("--kit <kitDir>").requiredOption("--out <dir>")
    .option("--force", "export even when the design and kit are unchanged").description("Export a design")
    .action(guard(async (dir: string, o: { kit: string; out: string; force?: boolean }) => {
      const r = await exportScreen(dir, path.resolve(o.kit), path.resolve(o.out), { force: o.force });
      if (r.skipped) io.out(`unchanged since the last export: ${r.outDir}\n`);
      else if (!r.ok) {
        for (const f of r.findings) io.out(line(f) + "\n");
        io.out(`lint found errors; wrote ${path.join(r.outDir, "lint-report.json")} only\n`);
      } else io.out(`exported to ${r.outDir} in ${r.totalMs} ms ` +
        `(${["load", "lint", "extract", "bake", "capture", "write"].map((k) => `${k} ${r.timings[k]}`).join(", ")})\n`);
      // jobs the design shows in no context: no golden, so a verify of this export is incomplete
      for (const h of r.hidden) io.out(`hidden in the design (not captured, a verify is incomplete): ${h.name}: ${h.reason}\n`);
      return r.ok ? 0 : 1;
    }) as never);

  program.command("compare").allowExcessArguments(false).argument("<exportDir>").requiredOption("--unity <captureDir>").requiredOption("--report <file>")
    .option("--verdict <file>", "verdict JSON (default: verdict.json next to the report)")
    .option("--diff <dir>", "difference images (default: <report name>-diff next to the report)")
    .option("--thresholds <file>", "thresholds JSON (default: fidelity-thresholds.json of this tool)")
    .description("Compare Unity captures with the design's goldens")
    .action(guard(async (dir: string, o: { unity: string; report: string; verdict?: string; diff?: string; thresholds?: string }) => {
      const exportDir = path.resolve(dir), unityDir = path.resolve(o.unity), report = path.resolve(o.report);
      const base = path.basename(report).replace(/\.html?$/i, "");
      const diffDir = o.diff ? path.resolve(o.diff) : path.join(path.dirname(report), `${base}-diff`);
      const t = readThresholds(o.thresholds ? path.resolve(o.thresholds) : undefined);
      const v = await compareScreen(exportDir, unityDir, t, { diffDir });
      writeReport(v, exportDir, unityDir, report);
      const verdictFile = o.verdict ? path.resolve(o.verdict) : path.join(path.dirname(report), "verdict.json");
      writeVerdict(v, verdictFile);
      const total = v.captures.length + v.notRun.length + v.hidden.length, passed = v.captures.filter((c) => c.pass).length;
      io.out(`${v.status.toUpperCase()} ${v.screen}: ${passed}/${total} captures pass (compare ${v.timings.compare} ms)\n`);
      if (v.notRun.length) io.out(`not run: ${v.notRun.join(", ")}\n`);
      if (v.hidden.length) io.out(`hidden in the design (not compared): ${v.hidden.join(", ")}\n`);
      if (v.extra.length) io.out(`extra Unity captures (not compared): ${v.extra.join(", ")}\n`);
      for (const w of v.warnings) io.out(`warning: ${w}\n`);
      const notSampled = v.captures.reduce((a, c) => a + c.notSampled.length, 0);
      if (notSampled) io.out(`backgrounds not sampled (every point covered or on text): ${notSampled}\n`);
      for (const line of summarizeIssues(v, 10, { notRun: false })) io.out(`- ${line}\n`);
      io.out(`report: ${report}\nverdict: ${verdictFile}\n`);
      return v.pass ? 0 : 1;
    }) as never);

  const contractCmd = program.command("contract").description("Screen contract commands");
  contractCmd.command("brief").allowExcessArguments(false).argument("<designDir>").requiredOption("--kit <kitDir>")
    .description("Print the design brief of a screen's contract")
    .action(guard(async (dir: string, o: { kit: string }) => {
      const load = readScreenContract(path.resolve(dir));
      if (load.state === "absent") { io.out(`no ${CONTRACT_FILE} in ${dir}\n`); return 1; }
      if (load.state === "invalid") { for (const p of load.problems) io.out(`${CONTRACT_FILE}: ${p}\n`); return 1; }
      io.out(contractBrief(load.contract, readKit(path.resolve(o.kit))));
      return 0;
    }) as never);

  const kitCmd = program.command("kit").description("Kit maintenance: generated kit files and the Claude Design System export");

  kitCmd.command("build").allowExcessArguments(false).argument("<kitDir>").option("--check", "only report stale generated files (exit 1)")
    .description("Regenerate base.css, RULES.md and the base block of every kit component and fixture")
    .action(guard(async (dir: string, o: { check?: boolean }) => {
      const r = buildKit(path.resolve(dir), { check: o.check });
      for (const f of r.changed) io.out(`${o.check ? "stale" : "wrote"} ${f}\n`);
      for (const w of r.warnings) io.out(`warning: ${w}\n`);
      for (const e of r.errors) io.out(`error: ${e}\n`);
      if (!r.changed.length && !r.errors.length) io.out("kit is current\n");
      return r.errors.length || (o.check && r.changed.length) ? 1 : 0;
    }) as never);

  kitCmd.command("upgrade").allowExcessArguments(false).argument("<kitDir>")
    .option("--from <cloneKit>", "the kit to upgrade to (default: this clone's design-kit)")
    .option("--dry-run", "print what would change; write nothing")
    .description("Bring a project's kit to this clone's kit, keeping the project's fonts, tokens, locales and own parts")
    .action(guard(async (dir: string, o: { from?: string; dryRun?: boolean }) => {
      const r = upgradeKit(path.resolve(dir), { from: o.from ? path.resolve(o.from) : undefined, dryRun: o.dryRun });
      const would = (verb: string, past: string) => (r.dryRun ? `would ${verb}` : past);
      if (r.dryRun) io.out("Dry run: nothing is changed.\n");
      io.out(`kit upgrade ${r.kitDir} from ${r.from}\n`);
      if (!r.ok) {
        for (const e of r.errors) io.out(`error: ${e}\n`);
        io.out("The merged kit does not build: nothing was written.\n");
        return 1;
      }
      io.out(r.replaced.length || r.added.length ? "" : "nothing to replace: the kit is the clone's version\n");
      if (r.replaced.length) io.out(`${would("replace", "replaced")}: ${r.replaced.join(", ")}\n`);
      if (r.added.length) io.out(`${would("add", "added")}: ${r.added.join(", ")}\n`);
      for (const k of r.kept) io.out(`${would("keep", "kept")}: ${k}\n`);
      for (const n of r.notes) io.out(`note: ${n}\n`);
      const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
      if (r.replaced.length || r.added.length) {
        if (r.dryRun) io.out(`would back up the replaced files into ${path.join(r.kitDir, ".backup", "<UTC time>", "files")} and name the added ones in kit-upgrade.json (the newest ${KEEP_BACKUPS} backups are kept)\n`);
        else {
          io.out(`backed up the replaced files into ${path.join(r.backup!, "files")}; ${path.join(r.backup!, "kit-upgrade.json")} names the replaced and added files\n`);
          const steps = [...(r.replaced.length ? [`cp -R ${q(path.join(r.backup!, "files"))}/. ${q(r.kitDir)}/`] : []),
            ...(r.added.length ? [`rm -f ${r.added.map((a) => q(path.join(r.kitDir, a))).join(" ")}`] : [])];
          io.out(`restore: ${steps.join(" && ")}\n`);
        }
      }
      for (const p of r.pruned) io.out(`removed the older backup ${p}\n`);
      io.out(`kit build and kit build --check: ${r.dryRun ? "pass on the merged copy" : "the kit is current"}\n`);
      return 0;
    }) as never);

  kitCmd.command("claude").allowExcessArguments(false).argument("<kitDir>").argument("<outDir>")
    .option("--title <title>", "design system name", DEFAULT_TITLE).option("--by <name>", "lastChange.by of the index", "design-export")
    .option("--force", "replace an existing <outDir>/project").option("--now <iso>", "the index's createdOnFiles.at and lastChange.at (default: now)")
    .option("--all-faces", "ship every face of the kit's fonts, not only those its text styles and font tokens reach")
    .description("Write the kit as a Claude Design System artifact folder (<outDir>/project)")
    .action(guard(async (kitDir: string, outDir: string, o: { title: string; by: string; force?: boolean; now?: string; allFaces?: boolean }) => {
      const now = o.now === undefined ? undefined : new Date(o.now);
      if (now && Number.isNaN(now.getTime())) throw new Error(`--now ${o.now} is not an ISO date`);
      const r = writeClaudeDesignSystem(path.resolve(kitDir), path.resolve(outDir), { title: o.title, by: o.by, force: o.force, now, allFaces: o.allFaces });
      for (const n of r.notes) io.out(`note: ${n}\n`);
      io.out(`wrote ${r.files.length} files to ${r.projectDir} (design-system.json last)\n`);
      return 0;
    }) as never);

  if (argv.length === 0) { io.err(USAGE); return 2; }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    io.err(`design-export: ${(e as Error).message}\n`);
    return 2;
  }
  return code;
}
