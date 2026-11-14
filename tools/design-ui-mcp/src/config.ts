import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CACHE_BUDGET_MB } from "./cache.js";

export const CONFIG_FILE = "design-ui.config.json";

export type RunnerRoute = "editor" | "command";
export type UnityStep = "import" | "capture" | "kitSync";

export interface DesignUiConfig {
  /** Absolute Unity project folder (the one holding Assets/). */
  projectDir: string;
  /** Absolute folder whose subfolders are the design screens (`<designRoot>/<screen-id>/`). */
  designRoot: string;
  /** Absolute design kit folder (kit.config.json, RULES.md, tokens, fonts). */
  kitDir: string;
  /** Unity asset path of the DesignUiProfile, as written in the config (e.g. Assets/DesignUi/DesignUiProfile.asset). */
  profileAsset: string;
  unityRunner: {
    /** Route for import and kit sync. `editor` = the open Editor's bridge; never falls back to `command`. */
    prefer: RunnerRoute;
    /** Route for verification captures; `command` (isolated batch run) unless the project allows the Editor. */
    captureVia: RunnerRoute;
    /** argv templates with {projectDir} {profile} {exportDir} {outDir} {kitDir}. */
    command: Record<UnityStep, string[]>;
    /** Limit for one Unity step (seconds). */
    timeoutSec: number;
  };
  /**
   * Budget of the screens' bookkeeping under designRoot (MB): over it, the exports of the screens least recently imported
   * or verified are removed, oldest first (cache.ts). Default DEFAULT_CACHE_BUDGET_MB.
   */
  cacheBudgetMB: number;
  /** Absolute path of the config file. */
  configPath: string;
}

const STEPS: UnityStep[] = ["import", "capture", "kitSync"];

function fail(file: string, msg: string): never {
  throw new Error(`${path.basename(file)} ${msg} (${file})`);
}

function str(file: string, raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (v === undefined) fail(file, `is missing "${key}"`);
  if (typeof v !== "string" || v.trim() === "") fail(file, `has an invalid "${key}": expected a non-empty string`);
  return v;
}

/** Reads `<projectDir>/design-ui.config.json`; throws with the missing or invalid key named. */
export function readConfig(projectDir: string): DesignUiConfig {
  const dir = path.resolve(projectDir);
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`${CONFIG_FILE} not found in ${dir}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(file, `is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(file, "must contain a JSON object");
  const o = raw as Record<string, unknown>;

  const designRoot = path.resolve(dir, str(file, o, "designRoot"));
  const kitDir = path.resolve(dir, str(file, o, "kitDir"));
  const profileAsset = str(file, o, "profileAsset");

  const ur = (o.unityRunner ?? {}) as Record<string, unknown>;
  if (typeof ur !== "object" || Array.isArray(ur)) fail(file, `has an invalid "unityRunner": expected an object`);
  const route = (key: string, def: RunnerRoute): RunnerRoute => {
    const v = ur[key] ?? def;
    if (v !== "editor" && v !== "command") fail(file, `has an invalid "unityRunner.${key}": expected "editor" or "command"`);
    return v;
  };
  const cmd = (ur.command ?? {}) as Record<string, unknown>;
  if (typeof cmd !== "object" || Array.isArray(cmd)) fail(file, `has an invalid "unityRunner.command": expected an object`);
  const command = {} as Record<UnityStep, string[]>;
  for (const step of STEPS) {
    const v = cmd[step] ?? [];
    if (!Array.isArray(v) || !v.every((a) => typeof a === "string")) {
      fail(file, `has an invalid "unityRunner.command.${step}": expected an array of strings (argv, no shell)`);
    }
    command[step] = v as string[];
  }
  const timeoutSec = ur.timeoutSec ?? 1800;
  if (typeof timeoutSec !== "number" || !(timeoutSec > 0)) fail(file, `has an invalid "unityRunner.timeoutSec": expected a positive number`);

  const cacheBudgetMB = o.cacheBudgetMB ?? DEFAULT_CACHE_BUDGET_MB;
  if (typeof cacheBudgetMB !== "number" || !(cacheBudgetMB > 0)) fail(file, `has an invalid "cacheBudgetMB": expected a positive number of megabytes`);

  return {
    projectDir: dir, designRoot, kitDir, profileAsset,
    unityRunner: { prefer: route("prefer", "editor"), captureVia: route("captureVia", "command"), command, timeoutSec },
    cacheBudgetMB,
    configPath: file,
  };
}
