import { Command, CommanderError } from "commander";
import path from "node:path";
import { exportScreen, lintScreen } from "./export.js";
import type { Finding } from "./lint/index.js";

export interface CliIo { out(s: string): void; err(s: string): void }

const USAGE = `Usage: design-export <command> [options]

Commands:
  lint <designDir> --kit <kitDir>                Lint a Claude Design HTML screen
  export <designDir> --kit <kitDir> --out <dir>  Export a screen: IR, goldens, assets, sample data
  compare                                        Compare a Unity capture against the golden (not available yet)

Exit codes: 0 ok, 1 lint errors, 2 usage or internal error.
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
      io.out(`${r.errors} error${r.errors === 1 ? "" : "s"}, ${r.findings.length - r.errors} warning${r.findings.length - r.errors === 1 ? "" : "s"}\n`);
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
      return r.ok ? 0 : 1;
    }) as never);

  program.command("compare").allowExcessArguments(false).description("Compare a Unity capture against the golden")
    .action(guard(async () => { io.err("design-export: compare is not available yet\n"); return 2; }) as never);

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
