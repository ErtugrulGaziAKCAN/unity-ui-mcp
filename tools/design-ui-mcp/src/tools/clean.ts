import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyClean, markBusy, mb, planClean, ScreenBusyError, type CleanPlan, type Removal } from "../cache.js";
import type { DesignUiConfig } from "../config.js";
import { requireConfig, type ServerContext } from "../context.js";
import { resolveScreen } from "../design.js";
import { guarded, Timings, toolResult } from "../result.js";
import { SCREEN_ARG } from "./status.js";

const rel = (cfg: DesignUiConfig, p: string) => path.relative(cfg.designRoot, p).split(path.sep).join("/");

/**
 * The cleanup the server runs by itself after an import or verify; returns a line for the tool's answer, or null.
 * `protect`: what the run that just finished keeps whatever the budget (the captures a verify was asked to keep).
 */
export function autoClean(cfg: DesignUiConfig, protect: readonly string[] = []): string | null {
  try {
    const plan = planClean(cfg.designRoot, cfg.cacheBudgetMB, undefined, { protect });
    if (!plan.removals.length) return null;
    const { removed, failed } = applyClean(plan);
    const freed = removed.reduce((a, r) => a + r.bytes, 0);
    return `Cleanup: removed ${removed.length} item${removed.length === 1 ? "" : "s"} of bookkeeping (${mb(freed)}; ${mb(plan.after)} of the ${mb(plan.budget)} budget in use)` +
      (failed.length ? `; ${failed.length} could not be removed (${failed[0].error})` : "") + ".";
  } catch (e) {
    return `Cleanup did not run: ${(e as Error).message}.`;
  }
}

/**
 * Runs an import or verify of a screen folder with its run marker set, so no cleanup touches what the run writes. One run
 * per folder: while another import or verify of it runs (this server or another process), the call is refused with an
 * error and touches nothing (the folder's runs share its export, staging folders and records).
 */
export async function whileBusy(screenDir: string, what: "import" | "verify", run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  let release: () => void;
  try { release = markBusy(screenDir, what); } catch (e) {
    if (!(e instanceof ScreenBusyError)) throw e;
    return toolResult(`${e.message} Nothing was exported, captured or written.`, {
      screen: e.screen, running: e.run ? { what: e.run.what, since: e.run.since, ...(e.run.pid !== process.pid ? { pid: e.run.pid } : {}) } : null,
    }, true);
  }
  try { return await run(); } finally { release(); }
}

/**
 * After an import or verify: the automatic cleanup, its line appended to the tool's answer (`cleanup` in the data). The
 * captures the run kept on request (its answer's `keptCaptures`) and the screen's export beside them, which the offline
 * comparison the answer prints reads, are not removed by this cleanup; a later one may.
 */
export function afterRun(cfg: DesignUiConfig, result: CallToolResult): CallToolResult {
  // a call refused because another run holds the screen (whileBusy's `running`) ran nothing: nothing to clean after it
  if ((result.structuredContent as { running?: unknown } | undefined)?.running !== undefined) return result;
  const kept = (result.structuredContent as { keptCaptures?: { dir?: unknown } | null } | undefined)?.keptCaptures?.dir;
  const line = autoClean(cfg, typeof kept === "string" ? [kept, path.join(path.dirname(kept), "export")] : []);
  if (!line) return result;
  const content = result.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${c.text}\n${line}` } : c));
  const data = result.structuredContent ? { ...result.structuredContent, cleanup: line } : undefined;
  if (data && content[1]?.type === "text") content[1] = { ...content[1], text: JSON.stringify(data, null, 2) };
  return { ...result, content, ...(data ? { structuredContent: data } : {}) };
}

function lines(cfg: DesignUiConfig, removals: Removal[]): string[] {
  return removals.map((r) => `- ${rel(cfg, r.path)} (${mb(r.bytes)}): ${r.why}`);
}

export function registerClean(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_clean", {
    title: "Clean the screens' bookkeeping",
    description:
      "Reports and removes what the server's own cleanup would remove from the screens' bookkeeping (<designRoot>/<screen>/.design-ui/): " +
      "Unity captures and difference images of finished verifications, the captures a verify kept on request (keepCaptures), the " +
      "captures an export kept when its capture failed (export.failed), staging " +
      "folders left behind, failed runs beyond the newest 3, and, while the bookkeeping is over cacheBudgetMB, the exports of the screens " +
      "least recently imported or verified (the next import or verify exports them again). Records, design files and a screen whose " +
      "import or verify is running are never touched. The cleanup also runs by itself after every import and verify (it keeps kept " +
      "captures unless the bookkeeping is over the budget): call this when the user asks about disk use, with dryRun to only report.",
    inputSchema: {
      screen: z.string().min(1).optional().describe(`Only this screen. ${SCREEN_ARG}`),
      dryRun: z.boolean().optional().describe("Only report what would be removed (default false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ screen, dryRun }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const folder = screen !== undefined ? path.basename(resolveScreen(screen, cfg.designRoot).dir) : undefined;
      // asked for: the captures a verify kept on request go too
      const plan: CleanPlan = t.sync("plan", () => planClean(cfg.designRoot, cfg.cacheBudgetMB, folder, { kept: true }));
      const scope = folder ? `screen ${folder}` : `designRoot ${cfg.designRoot}`;
      const head = `${scope}: ${mb(plan.before)} of bookkeeping (budget ${mb(plan.budget)} for designRoot)`;
      if (dryRun === true || plan.removals.length === 0) {
        const text = plan.removals.length
          ? [`${head}; would remove ${plan.removals.length} item${plan.removals.length === 1 ? "" : "s"} (${mb(plan.before - plan.after)}):`, ...lines(cfg, plan.removals)]
          : [`${head}; nothing to remove.`];
        return toolResult(text.join("\n"), {
          dryRun: dryRun === true, before: plan.before, after: plan.after, budget: plan.budget,
          removals: plan.removals.map((r) => ({ ...r, path: rel(cfg, r.path) })), timings: t.done(),
        });
      }
      const { removed, failed } = t.sync("remove", () => applyClean(plan));
      const text = [
        `${head}; removed ${removed.length} item${removed.length === 1 ? "" : "s"} (${mb(removed.reduce((a, r) => a + r.bytes, 0))}), ${mb(plan.after)} left:`,
        ...lines(cfg, removed),
        ...failed.map((f) => `- could not remove ${rel(cfg, f.removal.path)}: ${f.error}`),
      ];
      return toolResult(text.join("\n"), {
        dryRun: false, before: plan.before, after: plan.after, budget: plan.budget,
        removed: removed.map((r) => ({ ...r, path: rel(cfg, r.path) })), failed: failed.map((f) => ({ path: rel(cfg, f.removal.path), error: f.error })),
        timings: t.done(),
      }, failed.length > 0);
    });
  });
}
