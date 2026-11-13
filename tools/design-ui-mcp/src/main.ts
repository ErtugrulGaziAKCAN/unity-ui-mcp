import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./config.js";
import { Runtime } from "./runtime.js";
import { createServer, createUnconfiguredServer, VERSION } from "./server.js";

const USAGE = `design-ui-mcp ${VERSION}: MCP server (stdio) for unity-ui-mcp

Usage: node <repo>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>

  --project <dir>   Unity project folder (holds Assets/ and design-ui.config.json)
  --version         Print the version
  --help            Show this help

Register it in an MCP client, e.g. Claude Code:
  claude mcp add --scope local design-ui -- node <repo>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>
`;

function parseArgs(argv: string[]): { project: string | null } {
  let project: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { process.stdout.write(USAGE); process.exit(0); }
    if (a === "--version") { process.stdout.write(`${VERSION}\n`); process.exit(0); }
    if (a === "--project") { project = argv[++i] ?? null; continue; }
    if (a.startsWith("--project=")) { project = a.slice("--project=".length); continue; }
    process.stderr.write(`design-ui-mcp: unknown argument ${a}\n\n${USAGE}`);
    process.exit(2);
  }
  return { project };
}

async function main(): Promise<void> {
  const { project } = parseArgs(process.argv.slice(2));
  if (!project) {
    process.stderr.write(`design-ui-mcp: --project <UnityProjectDir> is required\n\n${USAGE}`);
    process.exit(2);
  }
  const projectDir = path.resolve(project);
  const runtime = new Runtime();

  let server;
  if (!fs.existsSync(projectDir)) {
    server = createUnconfiguredServer(projectDir, `the Unity project folder ${projectDir} does not exist (check --project)`, { runtime });
  } else {
    try {
      server = createServer(readConfig(projectDir), { runtime });
    } catch (e) {
      server = createUnconfiguredServer(projectDir, (e as Error).message, { runtime });
    }
  }

  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await runtime.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown(0);
  await server.connect(transport);
  process.stderr.write(`design-ui-mcp ${VERSION} ready for ${projectDir}\n`);
}

main().catch((e) => {
  process.stderr.write(`design-ui-mcp: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
