import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");
export const STUB_RUNNER = path.join(FIXTURES, "stub-runner.sh");
/** The exporter's lint test kit (Inter UI fonts, text styles): read only. */
export const KIT_DIR = path.resolve(here, "../../design-export/test/fixtures/lint/kit");

export function tempDir(prefix = "design-ui-mcp-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface TempProject {
  dir: string;
  designRoot: string;
  runnerLog: string;
  writeConfig(extra?: Record<string, unknown>): void;
  addScreen(id: string, fixture: string): string;
  runnerCalls(): string[];
}

/** A temp Unity project folder with design-ui.config.json, a designs folder and a stub command runner log. */
export function tempProject(opts: { prefer?: "editor" | "command"; exit?: number } = {}): TempProject {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "Assets"));
  const designRoot = path.join(dir, "Designs");
  fs.mkdirSync(designRoot);
  const runnerLog = path.join(dir, "runner.log");
  const stub = (exit: number) => ["sh", STUB_RUNNER, "--log", runnerLog, "--exit", String(exit)];
  const p: TempProject = {
    dir, designRoot, runnerLog,
    writeConfig(extra = {}) {
      const exit = opts.exit ?? 0;
      const cfg = {
        designRoot: "Designs",
        kitDir: KIT_DIR,
        profileAsset: "Assets/DesignUi/DesignUiProfile.asset",
        unityRunner: {
          prefer: opts.prefer ?? "command",
          command: {
            import: [...stub(exit), "import", "{projectDir}", "{profile}", "{exportDir}"],
            capture: [...stub(exit), "capture", "{exportDir}", "{outDir}"],
            kitSync: [...stub(exit), "kitSync", "{kitDir}"],
          },
        },
        ...extra,
      };
      fs.writeFileSync(path.join(dir, "design-ui.config.json"), JSON.stringify(cfg, null, 2));
    },
    addScreen(id, fixture) {
      const target = path.join(designRoot, id);
      fs.cpSync(path.join(FIXTURES, "designs", fixture), target, { recursive: true });
      return target;
    },
    runnerCalls() {
      return fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, "utf8").split("\n").filter(Boolean) : [];
    },
  };
  p.writeConfig();
  return p;
}

export interface StubBridge {
  port: number;
  token: string;
  requests: { method: string; path: string; auth: string | undefined; body: unknown }[];
  /** Answers of POST /import and /kit-sync. */
  answer: Record<string, unknown> & { code: number; log: string };
  /** Number of GET /status answers that still report isCompiling (and compiling) = true. */
  compilingPolls: number;
  /** Number of GET /status requests answered by dropping the connection (a domain reload), after the compiling ones. */
  downPolls: number;
  /** `lastCompile` of GET /status. */
  lastCompile: unknown;
  close(): Promise<void>;
}

/** A loopback HTTP server that behaves like the Unity Editor bridge, plus its Library/DesignUi/bridge.json. */
export async function startStubBridge(projectDir: string, opts: { tokenInFile?: string; projectPath?: string } = {}): Promise<StubBridge> {
  const token = "a".repeat(64);
  const state: StubBridge = {
    port: 0, token, requests: [], answer: { code: 0, log: "imported" }, compilingPolls: 0, downPolls: 0, lastCompile: null,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      state.requests.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      if (req.url === "/status" && req.method === "GET") {
        const compiling = state.compilingPolls > 0;
        if (compiling) state.compilingPolls--;
        else if (state.downPolls > 0) { state.downPolls--; req.socket.destroy(); return; }
        return send(200, {
          projectPath: opts.projectPath ?? projectDir, isCompiling: compiling, compiling, lastCompile: compiling ? null : state.lastCompile, busy: false, last: null,
        });
      }
      if ((req.url === "/import" || req.url === "/kit-sync") && req.method === "POST") return send(200, state.answer);
      return send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as { port: number }).port;
  const lib = path.join(projectDir, "Library", "DesignUi");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "bridge.json"), JSON.stringify({
    port: state.port, token: opts.tokenInFile ?? token, projectPath: opts.projectPath ?? projectDir, pid: process.pid, version: "0.1.0",
  }));
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

/** Connects an in-memory MCP client to the server. */
export async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "design-ui-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { data: any; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { ...r, data: r.structuredContent, text };
}

/** Minimal ZIP writer (stored entries) for safety tests; `mode` sets Unix permission bits (0o120777 = symlink). */
export function writeZip(file: string, entries: { name: string; data: string | Buffer; mode?: number }[]): void {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}
