import type { DesignUiConfig } from "./config.js";
import type { Pipeline } from "./pipeline.js";
import { progressOf, type ProgressExtra } from "./result.js";
import type { RunnerOptions } from "./runner.js";
import type { Runtime } from "./runtime.js";

export interface ServerContext {
  projectDir: string;
  /** null when design-ui.config.json is missing or invalid (configError says why). */
  cfg: DesignUiConfig | null;
  configError: string | null;
  runtime: Runtime;
  pipeline: Pipeline;
  runnerOptions: RunnerOptions;
}

export function requireConfig(ctx: ServerContext): DesignUiConfig {
  if (ctx.cfg) return ctx.cfg;
  throw new Error(`${ctx.configError ?? "design-ui.config.json could not be read"}. ` +
    `Create design-ui.config.json in the Unity project (scripts/setup.sh in the unity-ui-mcp repository writes one), then restart the MCP server.`);
}

/** The server's runner options for one tool call, with the call's progress notifications (when the client asked for them). */
export function withProgress(ctx: ServerContext, extra: ProgressExtra | undefined): RunnerOptions {
  const onProgress = progressOf(extra);
  return onProgress ? { ...ctx.runnerOptions, onProgress } : ctx.runnerOptions;
}
