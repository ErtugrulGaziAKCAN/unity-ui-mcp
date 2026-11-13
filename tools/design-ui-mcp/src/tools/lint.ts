import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireConfig, type ServerContext } from "../context.js";
import { openDesignInput } from "../design.js";
import { lint, openDesign, type Finding } from "../exporter.js";
import { guarded, Timings, toolResult } from "../result.js";

const MAX_LISTED = 30;

export function formatFindings(findings: Finding[]): string[] {
  const shown = findings.slice(0, MAX_LISTED).map((f) => `- ${f.ruleId} (${f.severity}) at ${f.path}: ${f.detail}\n  fix: ${f.fix}`);
  if (findings.length > MAX_LISTED) shown.push(`- … ${findings.length - MAX_LISTED} more (all are in the JSON result)`);
  return shown;
}

export const designArg = z.string().min(1).describe(
  "A screen id (folder name under designRoot), or a path to a design folder, an .html / .dc.html page or a .zip. " +
  "Relative paths are resolved under designRoot; absolute paths are allowed.");

export function registerLint(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_lint", {
    title: "Lint a design",
    description:
      "Checks one design against the contract in a real browser (the same Chromium and kit fonts the exporter uses) and " +
      "returns findings with rule id, element path and fix. Errors are design-side fixes: change the HTML/CSS (or tell the " +
      "design tool), never the Unity output. A ZIP is unpacked into a fresh temp folder (removed afterwards); unsafe entries are rejected.",
    inputSchema: { design: designArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ design }) => {
    const t = new Timings();
    return guarded(t, async () => {
      const cfg = requireConfig(ctx);
      const input = await t.async("resolve", () => openDesignInput(design, cfg.designRoot));
      try {
        const { kit } = t.sync("kit", () => ctx.runtime.kit(cfg.kitDir));
        const browser = await t.async("browser", () => ctx.runtime.browser());
        const d = await t.async("load", () => openDesign(input.entry, kit, kit.reference, browser));
        let findings: Finding[];
        try { findings = await t.async("lint", () => lint(d, kit)); } finally { await d.close(); }
        const errors = findings.filter((f) => f.severity === "error").length;
        const warnings = findings.length - errors;
        const shownEntry = input.zip
          ? `${input.zip} → ${path.basename(input.entry)}`
          : path.relative(cfg.designRoot, input.entry).startsWith("..") ? input.entry : path.relative(cfg.designRoot, input.entry);
        const head = errors
          ? `Lint failed: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in ${shownEntry}. Fix these in the design:`
          : `Lint passed: no errors${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""} in ${shownEntry}.`;
        return toolResult([head, ...formatFindings(findings)].join("\n"), {
          design, entry: shownEntry, ok: errors === 0, errors, warnings, findings, timings: t.done(),
        }, errors > 0);
      } finally {
        input.cleanup();
      }
    });
  });
}
