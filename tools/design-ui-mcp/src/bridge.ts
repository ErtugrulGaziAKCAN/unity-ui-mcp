import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** What the Unity package's Editor bridge writes to `<project>/Library/DesignUi/bridge.json`. */
export interface BridgeInfo { port: number; token: string; projectPath: string; pid?: number; version?: string }

export const bridgeFile = (projectDir: string) => path.join(projectDir, "Library", "DesignUi", "bridge.json");

function canonical(p: string): string {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* keep the resolved path */ }
  // macOS and Windows file systems are case-insensitive by default
  return process.platform === "darwin" || process.platform === "win32" ? out.toLowerCase() : out;
}

export const sameProject = (a: string, b: string) => canonical(a) === canonical(b);

/** The bridge of this project; null if bridge.json is absent, unreadable or belongs to another project. */
export function findBridge(projectDir: string): BridgeInfo | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(bridgeFile(projectDir), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const port = o.port, token = o.token, projectPath = o.projectPath;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== "string" || token.length === 0 || typeof projectPath !== "string") return null;
  if (!sameProject(projectPath, projectDir)) return null;
  return {
    port, token, projectPath,
    pid: typeof o.pid === "number" ? o.pid : undefined,
    version: typeof o.version === "string" ? o.version : undefined,
  };
}

export class BridgeHttpError extends Error {
  /** `timedOutMs`: the request's own limit ended it (no answer within that time). */
  constructor(message: string, readonly status: number | null, readonly timedOutMs: number | null = null) { super(message); }
}

/**
 * The timers a bridge request runs on (the real ones by default): tests pass a clock they advance themselves, so minutes
 * of a long Unity operation pass in no time.
 */
export interface BridgeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const REAL_CLOCK: BridgeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface BridgeRequestOptions {
  clock?: BridgeClock;
  /** Called every `waitEveryMs` while no answer has arrived, with the time waited so far. */
  onWait?: (elapsedMs: number) => void;
  waitEveryMs?: number;
}

/** How often an idle connection to the bridge is probed by TCP keep-alive while Unity works on a long request. */
const KEEP_ALIVE_MS = 15_000;

/**
 * One request to the bridge (127.0.0.1 only, Bearer token). Throws BridgeHttpError on transport errors and non-200.
 * The only limit is `timeoutMs` (the step's configured budget): the request goes through node:http on its own socket,
 * not fetch, whose undici dispatcher stops waiting for headers or body after a fixed 300 s, so a long import or kit sync
 * would fail at 300 s whatever unityRunner.timeoutSec says. The socket keeps the connection alive meanwhile, and
 * `onWait` reports the wait (an MCP tool turns it into progress notifications).
 */
export function bridgeRequest(info: BridgeInfo, method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, opts: BridgeRequestOptions = {}): Promise<any> {
  const clock = opts.clock ?? REAL_CLOCK;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const started = clock.now();
    let settled = false;
    let timer: unknown = null, ticker: unknown = null;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      if (ticker !== null) clock.clearInterval(ticker);
      f();
    };
    const unanswered = (cause: string) => new BridgeHttpError(`Unity Editor bridge on 127.0.0.1:${info.port} did not answer ${method} ${route} (${cause})`, null);
    // agent false: a socket of its own with no agent timeout; the bridge never redirects and node:http follows none
    const req = http.request({
      host: "127.0.0.1", port: info.port, path: route, method, agent: false,
      headers: {
        authorization: `Bearer ${info.token}`,
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (e) => finish(() => reject(unanswered((e as { code?: string }).code ?? e.name))));
      res.on("end", () => finish(() => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (res.statusCode !== 200) {
          const status = res.statusCode ?? 0;
          const reason = status === 401
            ? "the token in Library/DesignUi/bridge.json was rejected (401); restart the bridge in Unity (Window > Design UI > Status > Restart)"
            : status === 409 ? "the bridge is busy with another request (409)" : `HTTP ${status}${json?.error ? `: ${json.error}` : ""}`;
          reject(new BridgeHttpError(`Unity Editor bridge refused ${method} ${route}: ${reason}`, status));
          return;
        }
        resolve(json);
      }));
    });
    req.setTimeout(0);
    req.on("socket", (socket) => socket.setKeepAlive(true, KEEP_ALIVE_MS));
    req.on("error", (e) => finish(() => reject(unanswered((e as { code?: string }).code ?? e.name))));
    timer = clock.setTimeout(() => finish(() => {
      req.destroy();
      reject(new BridgeHttpError(`Unity Editor bridge on 127.0.0.1:${info.port} did not answer ${method} ${route} within ${Math.round(timeoutMs / 1000)} s`, null, timeoutMs));
    }), timeoutMs);
    if (opts.onWait && (opts.waitEveryMs ?? 0) > 0) {
      ticker = clock.setInterval(() => { if (!settled) opts.onWait!(clock.now() - started); }, opts.waitEveryMs!);
    }
    req.end(payload);
  });
}

export type BridgeState = "connected" | "not-found" | "not-responding" | "unauthorized";

export interface BridgeStatus {
  bridge: BridgeState;
  /** The Unity project this server serves. */
  projectPath: string;
  port?: number;
  version?: string;
  isCompiling?: boolean;
  busy?: boolean;
  last?: unknown;
  detail: string;
}

/** Bridge state for list/status: reads bridge.json and calls GET /status with the token. */
export async function bridgeStatus(projectDir: string, timeoutMs = 1500): Promise<BridgeStatus> {
  const info = findBridge(projectDir);
  if (!info) {
    return {
      bridge: "not-found", projectPath: projectDir,
      detail: `no Unity Editor bridge for this project (${path.relative(projectDir, bridgeFile(projectDir))} missing or for another project): open the project in Unity with the com.unity.design-ui package`,
    };
  }
  const base = { projectPath: projectDir, port: info.port, version: info.version };
  try {
    const s = await bridgeRequest(info, "GET", "/status", undefined, timeoutMs);
    return {
      ...base, bridge: "connected", isCompiling: !!s?.isCompiling, busy: !!s?.busy, last: s?.last ?? null,
      detail: `Unity Editor bridge listening on 127.0.0.1:${info.port}${s?.isCompiling ? " (compiling)" : ""}`,
    };
  } catch (e) {
    const status = e instanceof BridgeHttpError ? e.status : null;
    return {
      ...base, bridge: status === 401 ? "unauthorized" : "not-responding",
      detail: status === null
        ? `bridge.json names port ${info.port} but nothing answers: Unity is closed, reloading scripts, or the bridge is switched off in Window > Design UI > Status`
        : (e as Error).message,
    };
  }
}

/** Longest a status probe waits for the Editor, so status and list stay fast when it is closed or hung. */
export const PROBE_TIMEOUT_MS = 500;
/** How long one probe answer is reused. */
export const PROBE_MAX_AGE_MS = 3000;

const probes = new Map<string, { at: number; status: BridgeStatus }>();

/**
 * The bridge state for availability (status, list): bridgeStatus with a short timeout, reused for a few seconds per
 * bridge.json (an Editor that starts or restarts writes a new one, so it is probed at once). Without bridge.json nothing
 * is sent.
 */
export async function probeBridge(projectDir: string, opts: { timeoutMs?: number; maxAgeMs?: number } = {}): Promise<BridgeStatus> {
  let raw = "";
  try { raw = fs.readFileSync(bridgeFile(projectDir), "utf8"); } catch { return bridgeStatus(projectDir, opts.timeoutMs ?? PROBE_TIMEOUT_MS); }
  const key = `${canonical(projectDir)}\n${raw}`;
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < (opts.maxAgeMs ?? PROBE_MAX_AGE_MS)) return hit.status;
  const status = await bridgeStatus(projectDir, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  for (const k of probes.keys()) if (k.startsWith(`${canonical(projectDir)}\n`)) probes.delete(k);
  probes.set(key, { at: Date.now(), status });
  return status;
}
