#!/usr/bin/env tsx
import { runCli } from "./commands.js";

const code = await runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exit(code);
