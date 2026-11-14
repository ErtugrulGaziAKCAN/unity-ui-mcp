import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DesignUiConfig } from "./config.js";
import type { ServerContext } from "./context.js";
import { INSTALLED_PIPELINE, type Pipeline } from "./pipeline.js";
import type { RunnerOptions } from "./runner.js";
import { Runtime } from "./runtime.js";
import { registerImport } from "./tools/import.js";
import { registerKitSync } from "./tools/kitSync.js";
import { registerLint } from "./tools/lint.js";
import { registerList } from "./tools/list.js";
import { registerRules } from "./tools/rules.js";
import { availability, registerStatus } from "./tools/status.js";
import { registerVerify } from "./tools/verify.js";
import { VERSION } from "./version.js";

export { VERSION };
export const SERVER_NAME = "design-ui";
export const TOOL_NAMES = [
  "design_ui_rules", "design_ui_list", "design_ui_lint", "design_ui_import", "design_ui_verify", "design_ui_status", "design_ui_kit_sync",
] as const;

export interface ServerDeps {
  /** Warm browser and kit cache; the caller closes it on exit. A new one is made when absent. */
  runtime?: Runtime;
  /** Pipeline steps; defaults to what this version ships. */
  pipeline?: Pipeline;
  runnerOptions?: RunnerOptions;
}

/** The text every MCP client receives at initialize: the loop, and what this build can do. */
export function instructions(ctx: ServerContext): string {
  const a = availability(ctx);
  const live = Object.entries(a).filter(([, v]) => v.available).map(([k]) => k);
  const editor = Object.entries(a).filter(([, v]) => !v.available && v.needsEditor);
  const notYet = Object.entries(a).filter(([, v]) => !v.available && !v.needsEditor);
  return [
    `design-ui (unity-ui-mcp ${VERSION}) turns HTML screens designed under its kit (Claude Design or any AI) into Unity UI Toolkit`,
    "screens for the Unity project this server was started for, and measures the result against the design.",
    "",
    "Loop per screen:",
    "1. design_ui_rules: the design contract (attributes, text styles, fonts, allowed CSS, lint rules). Read it before writing or fixing HTML.",
    "2. design_ui_list: screens under designRoot (one folder per screen) and whether the Unity Editor bridge is connected.",
    "3. design_ui_lint { design }: fix every error in the design itself (or ask the design tool to), never in Unity output.",
    "4. design_ui_import { design }: export the design and compile it into the open Unity Editor. In a canvas folder with several",
    "   artboards, pass the artboard's path (<folder>/<artboard>.dc.html) to lint, import, verify and status.",
    "5. design_ui_verify { screen }: capture in Unity, compare with the design; report the verdict, report path and top issues.",
    "design_ui_status shows this version's capabilities; design_ui_kit_sync refreshes the kit fonts from Unity.",
    "Rules: never edit generated Unity files; never claim a pass that design_ui_verify did not return.",
    "",
    `Live in this version: ${live.join(", ")}.`,
    ...(editor.length
      ? ["Live while the Unity Editor bridge answers (otherwise they return isError: Editor not reachable, with the reason):", ...editor.map(([k, v]) => `- ${k}: ${v.note}`)]
      : []),
    ...(notYet.length
      ? ["Not available yet (they return isError with the reason; do not work around them):", ...notYet.map(([k, v]) => `- ${k}: ${v.note}`)]
      : []),
  ].join("\n");
}

function build(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: "Design UI (unity-ui-mcp)", version: VERSION }, { instructions: instructions(ctx) });
  registerRules(server, ctx);
  registerList(server, ctx);
  registerLint(server, ctx);
  registerImport(server, ctx);
  registerVerify(server, ctx);
  registerStatus(server, ctx);
  registerKitSync(server, ctx);
  return server;
}

const contextOf = (projectDir: string, cfg: DesignUiConfig | null, configError: string | null, deps: ServerDeps): ServerContext => ({
  projectDir, cfg, configError,
  runtime: deps.runtime ?? new Runtime(),
  pipeline: deps.pipeline ?? INSTALLED_PIPELINE,
  runnerOptions: deps.runnerOptions ?? {},
});

/** The design-ui MCP server for one Unity project: 7 tools and the design-ui://rules resource. */
export function createServer(cfg: DesignUiConfig, deps: ServerDeps = {}): McpServer {
  return build(contextOf(cfg.projectDir, cfg, null, deps));
}

/**
 * The same server when design-ui.config.json is missing or invalid: it still connects, serves the rules and
 * status, and every project tool answers with the configuration problem.
 */
export function createUnconfiguredServer(projectDir: string, reason: string, deps: ServerDeps = {}): McpServer {
  return build(contextOf(projectDir, null, reason, deps));
}
