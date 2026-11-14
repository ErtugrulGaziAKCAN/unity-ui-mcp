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

/**
 * A temp Unity project folder with design-ui.config.json, a designs folder and a stub command runner log. `importDone`:
 * what the stub's import writes as import-done.json (default: a confirmation of the export's IR).
 */
export function tempProject(opts: { prefer?: "editor" | "command"; exit?: number; importDone?: "ok" | "none" | "wrong" } = {}): TempProject {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "Assets"));
  const designRoot = path.join(dir, "Designs");
  fs.mkdirSync(designRoot);
  const runnerLog = path.join(dir, "runner.log");
  const stub = (exit: number) => ["sh", STUB_RUNNER, "--log", runnerLog, "--exit", String(exit), "--import-done", opts.importDone ?? "ok"];
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
  /** `version` and `irVersion` of GET /status (omitted while undefined, like an older bridge). */
  statusVersion?: string;
  statusIrVersion?: number;
  /** `scriptsFailed` of GET /status (omitted while undefined, like an older bridge). */
  scriptsFailed: boolean | undefined;
  /**
   * Holds the answers of the next POST /import and /kit-sync until `release`: `arrived` resolves once such a request has
   * reached the bridge (a long Unity operation, simulated without sleeping).
   */
  holdPosts(): { arrived: Promise<void>; release: () => void };
  close(): Promise<void>;
}

/**
 * A clock for the bridge transport (BridgeClock) that only moves when the test advances it: `advance(ms)` runs every
 * timer due in that time, in order, so minutes of a long Unity operation pass in no real time.
 */
export function manualClock() {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id as unknown; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id as unknown; },
    clearInterval: (h: unknown) => { timers.delete(h as number); },
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = Array.from(timers.entries()).filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

/** A loopback HTTP server that behaves like the Unity Editor bridge, plus its Library/DesignUi/bridge.json. */
export async function startStubBridge(projectDir: string, opts: { tokenInFile?: string; projectPath?: string } = {}): Promise<StubBridge> {
  const token = "a".repeat(64);
  const state: StubBridge = {
    port: 0, token, requests: [], answer: { code: 0, log: "imported" }, compilingPolls: 0, downPolls: 0, lastCompile: null, scriptsFailed: undefined,
    holdPosts: () => { throw new Error("not started"); }, close: async () => {},
  };
  let hold: { arrive: () => void; released: Promise<void> } | null = null;
  state.holdPosts = () => {
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    const released = new Promise<void>((r) => (release = r));
    hold = { arrive, released };
    return { arrived, release };
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
          ...(state.scriptsFailed === undefined ? {} : { scriptsFailed: compiling ? false : state.scriptsFailed }),
          ...(state.statusVersion === undefined ? {} : { version: state.statusVersion }),
          ...(state.statusIrVersion === undefined ? {} : { irVersion: state.statusIrVersion }),
        });
      }
      if ((req.url === "/import" || req.url === "/kit-sync") && req.method === "POST") {
        const h = hold;
        if (!h) return send(200, state.answer);
        hold = null;
        h.arrive();
        void h.released.then(() => send(200, state.answer));
        return;
      }
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
