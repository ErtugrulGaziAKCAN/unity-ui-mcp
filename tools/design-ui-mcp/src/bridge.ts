import fs from "node:fs";
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
  constructor(message: string, readonly status: number | null) { super(message); }
}

/** One request to the bridge (127.0.0.1 only, Bearer token). Throws BridgeHttpError on transport errors and non-200. */
export async function bridgeRequest(info: BridgeInfo, method: "GET" | "POST", route: string, body: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new BridgeHttpError(`Unity Editor bridge on 127.0.0.1:${info.port} did not answer ${method} ${route} (${cause})`, null);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status !== 200) {
    const reason = res.status === 401
      ? "the token in Library/DesignUi/bridge.json was rejected (401); restart the bridge in Unity (Window > Design UI > Status > Restart)"
      : res.status === 409 ? "the bridge is busy with another request (409)" : `HTTP ${res.status}${json?.error ? `: ${json.error}` : ""}`;
    throw new BridgeHttpError(`Unity Editor bridge refused ${method} ${route}: ${reason}`, res.status);
  }
  return json;
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
