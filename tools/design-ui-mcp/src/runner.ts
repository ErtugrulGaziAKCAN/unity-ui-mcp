import { spawn } from "node:child_process";
import { BridgeHttpError, bridgeRequest, findBridge, REAL_CLOCK, type BridgeClock, type BridgeInfo } from "./bridge.js";
import type { DesignUiConfig, RunnerRoute, UnityStep } from "./config.js";

/** A Unity step could not be run (no bridge, refused, timed out, command missing): not a Unity exit code. */
export class UnityRunnerError extends Error {
  /** What the step printed before it stopped (a timed-out command), when there is any. */
  log?: string;
}

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
  /** The project's scripts do not compile (Unity's last compilation failed); null from a bridge that does not say. */
  scriptsFailed: boolean | null;
}

/**
 * How the script compile after an import ended: reloaded (ok), failed (errors), not-started, or unknown (no result for this
 * import: the Editor restarted or another import's compile superseded it). An unknown result is ok only when the bridge
 * shows that the project's scripts compile (not compiling, scripts not failed).
 */
export interface CompileOutcome { id: number | null; state: "reloaded" | "failed" | "not-started" | "unknown"; ok: boolean; errors: string[] }

/** Thrown when the import ran (files written) but Unity was still compiling at the limit. */
export class CompileWaitTimeout extends UnityRunnerError {
  /** The import's warnings and errors as Unity answered them (the import ran; only its compile result is missing). */
  readonly warnings: string[];
  readonly errors: string[];
  constructor(message: string, readonly answer: ImportAnswer, issues: { warnings?: string[]; errors?: string[] } = {}) {
    super(message);
    this.warnings = issues.warnings ?? [];
    this.errors = issues.errors ?? [];
  }
}

export interface RunResult {
  code: number; logTail: string; via: RunnerRoute; timings: Record<string, number>;
  /** The step's log as far as it is kept (the command route keeps its last 32 to 64 KB): evidence of a failed step. */
  log: string;
  /**
   * The step's warnings and errors as Unity listed them, one entry each (Editor route; a bridge without the lists, and the
   * command route, give empty lists). The log tail can lose them: a long log keeps only its end.
   */
  warnings: string[]; errors: string[];
  /** Editor route, a bridge that reports them: the import's changed files and compile state. */
  answer?: ImportAnswer;
  /** Editor route, after a script change: how the compile ended (waited for, or already ended inside the import). */
  compile?: CompileOutcome;
  /** Editor route: whether the project's scripts failed to compile when the result was decided (null: not reported). */
  scriptsFailed?: boolean | null;
  /** Editor route: the errors of the bridge's last compile when it failed (they explain scriptsFailed). */
  scriptErrors?: string[];
}

/** The outcome of compile `id` from the bridge's lastCompile, else unknown (ok only when the scripts demonstrably compile). */
function outcomeOf(last: any, id: number | null, scriptsFailed: boolean | null): CompileOutcome {
  if (last && last.id === id && ["reloaded", "failed", "not-started"].includes(last.state)) {
    return { id, state: last.state, ok: last.state === "reloaded", errors: strings(last.errors) };
  }
  return { id, state: "unknown", ok: scriptsFailed === false, errors: [] };
}

const failedErrors = (last: any): string[] => (last?.state === "failed" ? strings(last.errors) : []);

export interface RunnerOptions {
  /** Poll interval while waiting for the Editor to finish compiling. */
  pollIntervalMs?: number;
  /** The Editor must report "not compiling" for this long before an import counts as done. */
  settleMs?: number;
  /** Limit for the wait after an import (scripts compile, domain reloads); default 300 s. */
  compileTimeoutMs?: number;
  /** Timers of the Unity request (tests); the real clock by default. */
  clock?: BridgeClock;
  /**
   * Called every `progressEveryMs` (default 10 s) while a Unity step runs, with a short line (`Unity import: 40 s`): a
   * tool forwards it to the client as MCP progress, so a client that resets its timeout on progress keeps waiting.
   */
  onProgress?: (message: string) => void;
  progressEveryMs?: number;
}

const STEP_LABEL: Record<UnityStep, string> = { import: "import", kitSync: "kit sync", capture: "capture" };
const progressLine = (step: UnityStep, elapsedMs: number, what = "running") =>
  `Unity ${STEP_LABEL[step]}: ${what}, ${Math.round(elapsedMs / 1000)} s`;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The bridge's import fields; null for an older bridge that answers only code and log. */
function importAnswer(res: any): ImportAnswer | null {
  if (typeof res?.compiling !== "boolean") return null;
  return {
    changed: strings(res.changed), imported: strings(res.imported), compiled: strings(res.compiled), compiling: res.compiling,
    compileId: typeof res.compileId === "number" ? res.compileId : null, ms: typeof res.ms === "number" ? res.ms : null,
    scriptsFailed: typeof res.scriptsFailed === "boolean" ? res.scriptsFailed : null,
  };
}

export const PLACEHOLDERS = ["projectDir", "profile", "exportDir", "outDir", "kitDir"] as const;
const LOG_TAIL_LINES = 40;
/** After the time limit, how long a stopped command may take to close its output before the step gives up on it. */
const COMMAND_KILL_GRACE_MS = 2000;
const LOG_TAIL_CHARS = 4000;

/**
 * A Unity step's errors and warnings as summary lines (errors first): a result shows them before the log tail, which keeps
 * only the end of a long log.
 */
export function unityIssues(run: { warnings?: string[]; errors?: string[] }): string[] {
  const list = (what: string, items: string[]) => (items.length ? [`Unity ${what} (${items.length}):`, ...items.map((i) => `- ${i}`)] : []);
  return [...list("errors", run.errors ?? []), ...list("warnings", run.warnings ?? [])];
}

/** A summary: the head line, Unity's errors and warnings, then the log tail (when there is one) last. */
export function withIssues(head: string, run: { warnings?: string[]; errors?: string[]; logTail?: string }, logTail = true): string {
  return [head, ...unityIssues(run), ...(logTail && run.logTail ? [`Log tail:\n${run.logTail}`] : [])].join("\n");
}

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
  return route === "editor" ? runEditor(cfg, step, all, opts) : runCommand(cfg, step, all, opts);
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
    // the step's whole budget is the request's only limit (no transport default); progress while Unity works
    res = await bridgeRequest(info, "POST", route, body, cfg.unityRunner.timeoutSec * 1000, {
      clock: opts.clock, waitEveryMs: opts.onProgress ? opts.progressEveryMs ?? 10_000 : 0,
      onWait: opts.onProgress ? (ms) => opts.onProgress!(progressLine(step, ms)) : undefined,
    });
  } catch (e) {
    if (e instanceof BridgeHttpError && e.status === 404 && step === "capture") {
      throw new UnityRunnerError(`this version of the com.unity.design-ui package has no Editor capture; use "unityRunner.captureVia": "command"`);
    }
    if (e instanceof BridgeHttpError && e.timedOutMs !== null) {
      throw new UnityRunnerError(`Unity Editor bridge on 127.0.0.1:${info.port} did not answer POST ${route} within ${Math.round(e.timedOutMs / 1000)} s (unityRunner.timeoutSec in ` +
        `${cfg.configPath}); Unity may still be working on it: check the Unity console, raise the limit for long steps`);
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
  let scriptsFailed: boolean | null = answer?.scriptsFailed ?? null;
  let scriptErrors = failedErrors(res?.lastCompile);
  if (code === 0 && step !== "capture" && (!answer || answer.compiling)) {
    const t1 = performance.now();
    if (answer) {
      const end = await waitForCompileEnd(cfg.projectDir, info, answer, opts, { warnings: strings(res?.warnings), errors: strings(res?.errors) });
      ({ compile, scriptsFailed } = end);
      scriptErrors = failedErrors(end.last);
    } else await waitForCompile(cfg.projectDir, info, opts); // a bridge without the compile fields: wait for "not compiling" to settle, as before
    timings.compileWait = Math.round(performance.now() - t1);
  } else if (answer && answer.compileId !== null) {
    // the compile already ended inside the import (failed, typically): its outcome is in the answer
    compile = outcomeOf(res.lastCompile, answer.compileId, answer.scriptsFailed);
  }
  timings.total = Math.round(performance.now() - t0);
  return {
    code, logTail: tail(log), log, via: "editor", timings, warnings: strings(res?.warnings), errors: strings(res?.errors),
    ...(answer && step === "import" ? { answer, scriptsFailed, scriptErrors } : {}), ...(compile ? { compile } : {}),
  };
}

/**
 * After an import that changed scripts: polls GET /status until `compiling` is false (the bridge keeps it true until the
 * domain reload, a failed compile or a compile that never starts). The bridge is down during the reload and may come back
 * on another port (re-read from bridge.json). `lastCompile` with this import's compileId says how it ended.
 */
async function waitForCompileEnd(projectDir: string, first: BridgeInfo, answer: ImportAnswer, opts: RunnerOptions, issues: { warnings: string[]; errors: string[] }):
  Promise<{ compile: CompileOutcome; scriptsFailed: boolean | null; last: unknown }> {
  const interval = opts.pollIntervalMs ?? 250;
  const limit = opts.compileTimeoutMs ?? 300_000;
  const t0 = Date.now(), deadline = t0 + limit;
  let reported = t0;
  let info: BridgeInfo = first;
  for (;;) {
    if (opts.onProgress && Date.now() - reported >= (opts.progressEveryMs ?? 10_000)) {
      reported = Date.now();
      opts.onProgress(progressLine("import", reported - t0, "compiling the generated scripts"));
    }
    try {
      const s = await bridgeRequest(info, "GET", "/status", undefined, Math.max(1000, interval * 4));
      if (s?.compiling === false) {
        const scriptsFailed = typeof s.scriptsFailed === "boolean" ? s.scriptsFailed : null;
        return { compile: outcomeOf(s.lastCompile, answer.compileId, scriptsFailed), scriptsFailed, last: s.lastCompile };
      }
    } catch {
      info = findBridge(projectDir) ?? info; // reloading: the bridge restarts and rewrites bridge.json
    }
    if (Date.now() > deadline) {
      throw new CompileWaitTimeout(`the import wrote ${answer.changed.length} files, but Unity was still compiling the changed scripts ` +
        `(${answer.compiled.join(", ")}) after ${Math.round(limit / 1000)} s; check the Unity console`, answer, issues);
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

async function runCommand(cfg: DesignUiConfig, step: UnityStep, vars: Record<string, string>, opts: RunnerOptions = {}): Promise<RunResult> {
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
    let timedOut = false, done = false;
    let grace: unknown = null;
    const clock = opts.clock ?? REAL_CLOCK;
    const started = clock.now();
    const timedOutError = () => {
      const e = new UnityRunnerError(`"${argv[0]}" (${step}) did not finish within ${cfg.unityRunner.timeoutSec} s and was stopped; log tail:\n${tail(log)}`);
      e.log = log;
      return e;
    };
    const timer = clock.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // a command that ignores SIGTERM, or a grandchild that keeps the output pipes open, would hold the result: after a
      // grace (on the same clock) the command is killed, its pipes are cut and nothing of this run keeps ticking
      grace = clock.setTimeout(() => {
        if (done) return;
        done = true;
        stop();
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        reject(timedOutError());
      }, COMMAND_KILL_GRACE_MS);
    }, timeoutMs);
    // a capture or import in a batch Unity takes minutes: report the wait (MCP progress) while it runs
    const ticker = opts.onProgress ? clock.setInterval(() => opts.onProgress!(progressLine(step, clock.now() - started)), opts.progressEveryMs ?? 10_000) : null;
    const stop = () => { clock.clearTimeout(timer); if (ticker !== null) clock.clearInterval(ticker); if (grace !== null) { clock.clearTimeout(grace); grace = null; } };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => {
      stop();
      if (done) return;
      done = true;
      reject(new UnityRunnerError(`could not start "${argv[0]}" for ${step}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      stop();
      if (done) return;
      done = true;
      if (timedOut) {
        reject(timedOutError());
        return;
      }
      resolve({
        code: code ?? (signal ? 128 : 1), logTail: tail(log), log, via: "command", warnings: [], errors: [],
        timings: { total: Math.round(performance.now() - t0) },
      });
    });
  });
}
