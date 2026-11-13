import { spawn } from "node:child_process";
import { BridgeHttpError, bridgeRequest, findBridge, type BridgeInfo } from "./bridge.js";
import type { DesignUiConfig, RunnerRoute, UnityStep } from "./config.js";

/** A Unity step could not be run (no bridge, refused, timed out, command missing): not a Unity exit code. */
export class UnityRunnerError extends Error {}

/** What the Editor bridge's import answers besides code and log (files as the bridge names them). */
export interface ImportAnswer {
  /** Files the import wrote because their content changed. */
  changed: string[];
  /** Of those, the project files Unity imported. */
  imported: string[];
  /** Of those, the C# files: Unity compiles and reloads the scripts after the answer. */
  compiled: string[];
  /** The Editor still has to compile and reload for this import (true only with `compiled`). */
  compiling: boolean;
  /** Ties the bridge's `lastCompile` to this import. */
  compileId: number | null;
  /** Milliseconds of the import on the Editor's main thread. */
  ms: number | null;
}

/** How the script compile after an import ended: reloaded (ok), failed (errors), not-started, or unknown (no result for this import). */
export interface CompileOutcome { id: number | null; state: "reloaded" | "failed" | "not-started" | "unknown"; ok: boolean; errors: string[] }

export interface RunResult {
  code: number; logTail: string; via: RunnerRoute; timings: Record<string, number>;
  /** Editor route, a bridge that reports them: the import's changed files and compile state. */
  answer?: ImportAnswer;
  /** Editor route, after a script change: how the compile ended (the runner waited for it). */
  compile?: CompileOutcome;
}

export interface RunnerOptions {
  /** Poll interval while waiting for the Editor to finish compiling. */
  pollIntervalMs?: number;
  /** The Editor must report "not compiling" for this long before an import counts as done. */
  settleMs?: number;
  /** Limit for the wait after an import (scripts compile, domain reloads); default 300 s. */
  compileTimeoutMs?: number;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The bridge's import fields; null for an older bridge that answers only code and log. */
function importAnswer(res: any): ImportAnswer | null {
  if (typeof res?.compiling !== "boolean") return null;
  return {
    changed: strings(res.changed), imported: strings(res.imported), compiled: strings(res.compiled), compiling: res.compiling,
    compileId: typeof res.compileId === "number" ? res.compileId : null, ms: typeof res.ms === "number" ? res.ms : null,
  };
}

export const PLACEHOLDERS = ["projectDir", "profile", "exportDir", "outDir", "kitDir"] as const;
const LOG_TAIL_LINES = 40;
const LOG_TAIL_CHARS = 4000;

export function tail(log: string): string {
  const lines = log.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const out = lines.slice(-LOG_TAIL_LINES).join("\n");
  return out.length > LOG_TAIL_CHARS ? "…" + out.slice(-LOG_TAIL_CHARS) : out;
}

/** Substitutes {projectDir} {profile} {exportDir} {outDir} {kitDir}; unknown or unset placeholders are errors. */
export function expandTemplate(argv: string[], vars: Record<string, string | undefined>): string[] {
  return argv.map((arg) => arg.replace(/\{([A-Za-z]+)\}/g, (m, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new UnityRunnerError(`unknown placeholder ${m} in a unityRunner.command template (known: ${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")})`);
    }
    const v = vars[name];
    if (v === undefined || v === "") throw new UnityRunnerError(`placeholder ${m} has no value for this step`);
    return v;
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one Unity step. import/kitSync use `unityRunner.prefer`; capture uses `unityRunner.captureVia` (command by
 * default, so the user's open Editor is never put into a capture). The editor route never falls back to the command
 * route. Resolves with Unity's own result code; rejects with UnityRunnerError when the step could not run at all.
 */
export async function runUnity(cfg: DesignUiConfig, step: UnityStep, vars: Record<string, string>, opts: RunnerOptions = {}): Promise<RunResult> {
  const all: Record<string, string> = { projectDir: cfg.projectDir, profile: cfg.profileAsset, kitDir: cfg.kitDir, ...vars };
  const route = step === "capture" ? cfg.unityRunner.captureVia : cfg.unityRunner.prefer;
  return route === "editor" ? runEditor(cfg, step, all, opts) : runCommand(cfg, step, all);
}

async function runEditor(cfg: DesignUiConfig, step: UnityStep, vars: Record<string, string>, opts: RunnerOptions): Promise<RunResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const info = findBridge(cfg.projectDir);
  if (!info) {
    throw new UnityRunnerError(
      `Editor not reachable: Unity Editor bridge not found for ${cfg.projectDir}: open this project in Unity with the com.unity.design-ui package ` +
      `(Window > Design UI > Status shows the bridge), or set "unityRunner.prefer": "command" in design-ui.config.json.`);
  }
  const route = step === "import" ? "/import" : step === "kitSync" ? "/kit-sync" : "/capture";
  const body = step === "import"
    ? { profile: vars.profile, exportDir: vars.exportDir, discardManualEdits: vars.discardManualEdits === "true" }
    : step === "kitSync" ? { profile: vars.profile, kitDir: vars.kitDir }
    : { profile: vars.profile, exportDir: vars.exportDir, outDir: vars.outDir };
  let res: any;
  try {
    res = await bridgeRequest(info, "POST", route, body, cfg.unityRunner.timeoutSec * 1000);
  } catch (e) {
    if (e instanceof BridgeHttpError && e.status === 404 && step === "capture") {
      throw new UnityRunnerError(`this version of the com.unity.design-ui package has no Editor capture; use "unityRunner.captureVia": "command"`);
    }
    // no answer at all (closed, reloading, switched off) is an unreachable Editor; a refusal (401, 409) is not
    const unreachable = e instanceof BridgeHttpError && e.status === null;
    throw new UnityRunnerError(`${unreachable ? "Editor not reachable: " : ""}${(e as Error).message}`);
  }
  timings.request = Math.round(performance.now() - t0);
  const code = typeof res?.code === "number" ? res.code : 1;
  const log = typeof res?.log === "string" ? res.log : "";
  const answer = importAnswer(res);
  let compile: CompileOutcome | undefined;
  if (code === 0 && step !== "capture" && (!answer || answer.compiling)) {
    const t1 = performance.now();
    // a bridge without the compile fields: wait for "not compiling" to settle, as before
    if (answer) compile = await waitForCompileEnd(cfg.projectDir, info, answer, opts);
    else await waitForCompile(cfg.projectDir, info, opts);
    timings.compileWait = Math.round(performance.now() - t1);
  }
  timings.total = Math.round(performance.now() - t0);
  return { code, logTail: tail(log), via: "editor", timings, ...(answer && step === "import" ? { answer } : {}), ...(compile ? { compile } : {}) };
}

/**
 * After an import that changed scripts: polls GET /status until `compiling` is false (the bridge keeps it true until the
 * domain reload, a failed compile or a compile that never starts). The bridge is down during the reload and may come back
 * on another port (re-read from bridge.json). `lastCompile` with this import's compileId says how it ended.
 */
async function waitForCompileEnd(projectDir: string, first: BridgeInfo, answer: ImportAnswer, opts: RunnerOptions): Promise<CompileOutcome> {
  const interval = opts.pollIntervalMs ?? 250;
  const limit = opts.compileTimeoutMs ?? 300_000;
  const deadline = Date.now() + limit;
  let info: BridgeInfo = first;
  for (;;) {
    try {
      const s = await bridgeRequest(info, "GET", "/status", undefined, Math.max(1000, interval * 4));
      if (s?.compiling === false) {
        const last = s.lastCompile;
        if (last && last.id === answer.compileId && ["reloaded", "failed", "not-started"].includes(last.state)) {
          return { id: answer.compileId, state: last.state, ok: last.state === "reloaded", errors: strings(last.errors) };
        }
        return { id: answer.compileId, state: "unknown", ok: false, errors: [] };
      }
    } catch {
      info = findBridge(projectDir) ?? info; // reloading: the bridge restarts and rewrites bridge.json
    }
    if (Date.now() > deadline) {
      throw new UnityRunnerError(`the import wrote ${answer.changed.length} files, but Unity was still compiling the changed scripts ` +
        `(${answer.compiled.join(", ")}) after ${Math.round(limit / 1000)} s; check the Unity console`);
    }
    await sleep(interval);
  }
}

/**
 * An older bridge (no compile fields in its answer): after an import the Editor may compile and reload scripts; the bridge
 * stops during the reload and comes back (possibly on another port, re-read from bridge.json). Done when it reports
 * "not compiling" for `settleMs`.
 */
async function waitForCompile(projectDir: string, first: BridgeInfo, opts: RunnerOptions): Promise<void> {
  const interval = opts.pollIntervalMs ?? 250;
  const settle = opts.settleMs ?? 750;
  const deadline = Date.now() + (opts.compileTimeoutMs ?? 300_000);
  let idleSince: number | null = null;
  let info: BridgeInfo = first;
  for (;;) {
    let compiling = true;
    try {
      const s = await bridgeRequest(info, "GET", "/status", undefined, Math.max(1000, interval * 4));
      compiling = !!s?.isCompiling || !!s?.busy;
    } catch {
      info = findBridge(projectDir) ?? info; // reloading: the bridge restarts and rewrites bridge.json
    }
    const now = Date.now();
    if (compiling) idleSince = null;
    else if (idleSince === null) idleSince = now;
    else if (now - idleSince >= settle) return;
    if (now > deadline) {
      throw new UnityRunnerError(`the import ran, but Unity was still compiling or reloading after ${Math.round((opts.compileTimeoutMs ?? 300_000) / 1000)} s; check the Unity console`);
    }
    await sleep(interval);
  }
}

async function runCommand(cfg: DesignUiConfig, step: UnityStep, vars: Record<string, string>): Promise<RunResult> {
  const t0 = performance.now();
  const template = cfg.unityRunner.command[step];
  if (!template.length) {
    throw new UnityRunnerError(`"unityRunner.command.${step}" is not configured in ${cfg.configPath}`);
  }
  const argv = expandTemplate(template, vars);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DESIGN_UI_")) env[k] = v;
  // the same values as environment variables (DESIGN_UI_EXPORT_DIR, …), for runners such as an EditMode capture test
  // DESIGN_UI_IMPORT_DONE: where the import writes its done marker (the IR SHA-256 it imported), checked by design_ui_import
  for (const k of [...PLACEHOLDERS, "discardManualEdits", "importDone"]) {
    if (vars[k]) env[`DESIGN_UI_${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`] = vars[k];
  }
  const timeoutMs = cfg.unityRunner.timeoutSec * 1000;
  return new Promise<RunResult>((resolve, reject) => {
    let log = "";
    const keep = (chunk: Buffer) => {
      log += chunk.toString("utf8");
      if (log.length > 64 * 1024) log = log.slice(-32 * 1024);
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cfg.projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new UnityRunnerError(`could not start "${argv[0]}" for ${step}: ${(e as Error).message}`));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new UnityRunnerError(`could not start "${argv[0]}" for ${step}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new UnityRunnerError(`"${argv[0]}" (${step}) did not finish within ${cfg.unityRunner.timeoutSec} s and was stopped; log tail:\n${tail(log)}`));
        return;
      }
      resolve({
        code: code ?? (signal ? 128 : 1), logTail: tail(log), via: "command",
        timings: { total: Math.round(performance.now() - t0) },
      });
    });
  });
}
