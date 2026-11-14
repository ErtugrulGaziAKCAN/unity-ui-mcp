import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { renderRules, rulesJson, splitSections, viewportClassOf, type KitConfig, type RulesJson } from "../exporter.js";
import { REPO_KIT_DIR } from "../paths.js";

import { guarded, Timings, toolResult } from "../result.js";

/**
 * The design contract (spec §5): the kit's RULES.md, the generated single source, with an index of its sections; the
 * same contract as compact data (rules with severity and fix, the allowed CSS in brief, the kit's text styles and fonts)
 * comes only with `section: "json"`, so the default answer stays within the 50 KB budget. A kit without its own RULES.md
 * gets one rendered from its own files. Nothing here is a copy: both come from the exporter's kit and lint data.
 */
const isStub = (md: string) => md.replace(/^#.*$/gm, "").trim().length < 40;

/**
 * The kit's viewports by class: `exact 2560×1440, 1920×1080; scaled 1366×768` (exact: every kit value whole device px;
 * scaled: laid out and verified, exempt from the whole-device-pixel rules).
 */
export function kitViewports(kit: Pick<KitConfig, "viewports" | "scaledViewports">): string {
  const of = (cls: "exact" | "scaled") => kit.viewports.filter((v) => viewportClassOf(kit.scaledViewports, v) === cls).map((v) => v.join("×"));
  const scaled = of("scaled");
  return `exact ${of("exact").join(", ")}` + (scaled.length ? `; scaled ${scaled.join(", ")}` : "");
}

export interface RulesBundle {
  markdown: string;
  json: RulesJson;
  meta: { kitDir: string; rulesFile: string | null; rulesSource: "file" | "generated"; sections: string[]; notes: string[] };
}

export function buildRules(ctx: ServerContext, t: Timings): RulesBundle {
  const configured = ctx.cfg?.kitDir;
  const kitDir = configured && fs.existsSync(path.join(configured, "kit.config.json")) ? configured : REPO_KIT_DIR;
  const notes: string[] = [];
  if (configured && kitDir !== configured) notes.push(`The configured kit (${configured}) has no kit.config.json; showing the repository's default kit.`);
  const kit: KitConfig = t.sync("kit", () => ctx.runtime.kit(kitDir).kit);

  const file = path.join(kitDir, "RULES.md");
  const own = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const fromFile = own.trim() !== "" && !isStub(own);
  const rules = t.sync("render", () => (fromFile ? own : renderRules(kit, "kit")));
  if (!fromFile) notes.push(`The kit has no RULES.md of its own: generated from its files (${kitDir}).`);
  const json = t.sync("json", () => rulesJson(kit));

  const sections = splitSections(rules).map((s) => s.id);
  const header = [
    `Kit: ${kitDir} (reference ${kit.reference.join("×")}, viewports ${kitViewports(kit)}, locales ${kit.locales.join(", ")})`,
    ...notes.map((n) => `> ${n}`),
    `Sections (design_ui_rules { section } returns one): ${sections.join(", ")}; json is the same contract as compact JSON (rules, css, textStyles, fonts).`,
  ].join("\n");
  return {
    markdown: `${header}\n\n${rules.trim()}\n`,
    json,
    meta: { kitDir, rulesFile: fromFile ? file : null, rulesSource: fromFile ? "file" : "generated", sections, notes },
  };
}

/** RULES.md with its section index (the default), one Markdown section by its id, or `json` for the data alone. */
export function rulesAnswer(b: RulesBundle, section: string | undefined, t: Timings): CallToolResult {
  const meta = { ...b.meta, section: section ?? null, timings: t.done() };
  if (!section || section === "all") return { content: [{ type: "text", text: b.markdown }], structuredContent: meta };
  const data = { ...b.json, ...meta };
  if (section === "json") return { content: [{ type: "text", text: JSON.stringify(b.json) }], structuredContent: data };
  const s = splitSections(b.markdown).find((x) => x.id === section);
  if (!s) {
    return toolResult(`No section "${section}". Sections: ${["json", ...b.meta.sections].join(", ")}.`,
      { ...b.meta, section, timings: data.timings }, true);
  }
  return { content: [{ type: "text", text: s.text }], structuredContent: meta };
}

export function registerRules(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_rules", {
    title: "Design rules",
    description:
      "The design contract for HTML screens that are turned into Unity UI Toolkit: the kit's RULES.md (screen and markup " +
      "attributes, base stylesheet, text styles, tokens, allowed CSS, every lint rule with its fix, an example) with an index " +
      "of its sections. Read it once before writing or fixing a design. `section` returns one part: a heading id such as " +
      "`text-styles`, `allowed-css` or `lint-rules`, or `json` (the same contract as compact JSON). Also available as the " +
      "resource design-ui://rules.",
    inputSchema: { section: z.string().min(1).optional().describe("One part only: a RULES.md heading id (e.g. text-styles, lint-rules) or json.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ section }) => {
    const t = new Timings();
    return guarded(t, async () => rulesAnswer(buildRules(ctx, t), section, t));
  });

  server.registerResource("rules", "design-ui://rules", {
    title: "Design rules",
    description: "The kit's RULES.md (Markdown), as design_ui_rules returns it.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildRules(ctx, new Timings()).markdown }] }));
}
