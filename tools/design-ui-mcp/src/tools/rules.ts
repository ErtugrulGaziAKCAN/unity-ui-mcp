import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { CSS_SUPPORT_DATA, RULES, readTextStyles, type CssSupportData, type KitConfig, type TextStyle } from "../exporter.js";
import { REPO_KIT_DIR } from "../paths.js";
import { guarded, Timings, toolResult } from "../result.js";
import { RULE_SUMMARIES } from "../rule-table.js";

/** Markup contract (spec §5.2): what every design must carry so the screen compiles, binds and localizes. */
export const ATTRIBUTES: { name: string; meaning: string; required: string }[] = [
  { name: "data-u-screen", meaning: "Screen id on the root element, e.g. `club.overview`", required: "yes, exactly once" },
  { name: "data-u-id", meaning: "Stable element name exposed to code", required: "on every interactive or bound element" },
  { name: "data-l10n", meaning: "Localization key in meaningful English, e.g. `club.overview.title`", required: "on every visible static text" },
  { name: "data-en", meaning: "English source text for that key (the element's own text is the design-language text)", required: "with `data-l10n`" },
  { name: "data-u-arg", meaning: "On a `<span>` inside localized text: a Smart String argument with sample text; `data-en` uses `{name}`", required: "when the text has variables" },
  { name: "data-l10n-args", meaning: "Smart String argument names, e.g. `amount,currency`", required: "optional" },
  { name: "data-l10n-<attr>, data-en-<attr>", meaning: "Key and English text for `placeholder`, `title`, `alt`, `aria-label`", required: "when such an attribute has text" },
  { name: "data-u-bind", meaning: "Dynamic, non-translated value (player name, number)", required: "for runtime values" },
  { name: "data-u-action", meaning: "Command raised on activation, e.g. `open-inbox`", required: "on actionable elements" },
  { name: "data-u-repeat", meaning: "Repeated item template, e.g. `players`", required: "on the first sample item" },
  { name: "data-u-repeat-mode", meaning: "`list` (virtualized, default inside a scroll area) or `inline`", required: "optional" },
  { name: "data-u-state", meaning: "Screen state variant root, e.g. `loading`, `empty`, `error`", required: "on state roots" },
  { name: "data-u-external", meaning: "Region drawn by the host (e.g. an existing uGUI shell); not compiled, masked in comparison", required: "optional" },
];

const code = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(", ");

/** The allowed-CSS whitelist (the exporter's lint data) as compact Markdown. */
export function allowedCssMarkdown(d: CssSupportData = CSS_SUPPORT_DATA): string {
  const props = Object.entries(d.properties).sort(([a], [b]) => (a < b ? -1 : 1));
  const describe = ([name, p]: [string, (typeof props)[number][1]]) => {
    const parts: string[] = [];
    if (p.keywords?.length) parts.push(p.keywords.join(" | "));
    if (p.types?.length) parts.push(`<${p.types.join(" | ")}>`);
    const values = parts.length ? `: ${parts.join(" or ")}` : "";
    const rule = p.rule ? ` (${p.rule})` : "";
    return `- \`${name}\`${values}${p.list ? " (comma list)" : ""}${rule}`;
  };
  const group = (h: string) => props.filter(([, p]) => p.handling === h).map(describe);
  const atRules = Object.entries(d.atRules);
  return [
    "Lint is a whitelist: anything not listed here fails (U-CSS-023 for properties, keywords and units, U-CSS-024 for value functions).",
    "Properties are listed as longhands; shorthands (`margin`, `padding`, `border`, `flex`, `gap`, `inset`, `overflow`, `transition`, `animation`, `font`, `background`) are fine when every longhand they set is allowed.",
    "",
    "**Written to USS as is:**", ...group("direct"), "",
    "**Rewritten by the compiler (allowed):**", ...group("lowered"), "",
    "**Accepted and left out of USS (baked by the exporter or no effect):**", ...group("dropped"), "",
    "**Never supported:**", ...group("error"), "",
    `**Units:** ${code(d.units)}. **Colours:** hex, ${code(d.colors.functions.map((f) => `${f}()`))}, keywords ${code(d.colors.keywords)}.`,
    `**Value functions:** ${code(d.valueFunctions.map((f) => `${f}()`))}. **Transform functions:** ${code(d.transformFunctions)}.`,
    `**Timing functions:** ${code(d.timingKeywords)}. **Keyframe properties:** ${code(d.keyframeProperties)}.`,
    `**Pseudo-classes:** ${code(d.pseudoClasses.map((c) => `:${c}`))}. **Pseudo-elements:** ${code(d.pseudoElements.map((e) => `::${e}`))} (\`::before\`/\`::after\` only without content).`,
    `**At-rules:** ${atRules.map(([n, w]) => `\`@${n}\`${w === "kit" ? " (kit files only)" : ""}`).join(", ")}; \`@media\` features ${code(d.mediaFeatures)}, media types ${code(d.mediaTypes)}.`,
    `**Elements:** ${code(d.elements)}, inline \`<svg>\` (exported as a vector asset; SVG presentation attributes allowed inside). **\`<input>\` types:** ${code(d.inputTypes)}.`,
  ].join("\n");
}

/** `font-family` values declared by @font-face in the kit's fonts.css, with their weights. */
export function kitFontFamilies(kit: KitConfig): Record<string, string[]> | null {
  const file = path.join(kit.dir, kit.fontsCss);
  if (!fs.existsSync(file)) return null;
  const css = fs.readFileSync(file, "utf8");
  const out: Record<string, string[]> = {};
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const fam = /font-family\s*:\s*(["']?)([^;"']+)\1/i.exec(m[1])?.[2]?.trim();
    if (!fam) continue;
    const w = /font-weight\s*:\s*([^;]+)/i.exec(m[1])?.[1]?.trim() ?? "400";
    const st = /font-style\s*:\s*italic/i.test(m[1]) ? " italic" : "";
    (out[fam] ??= []).push(`${w}${st}`);
  }
  return out;
}

const isStub = (md: string) => md.replace(/^#.*$/gm, "").trim().length < 40;

export interface RulesBundle { text: string; data: Record<string, unknown> }

/** Everything a design AI needs to produce compliant HTML: RULES.md, attributes, text styles, fonts, CSS and lint rules. */
export function buildRules(ctx: ServerContext, t: Timings): RulesBundle {
  const configured = ctx.cfg?.kitDir;
  const kitDir = configured && fs.existsSync(path.join(configured, "kit.config.json")) ? configured : REPO_KIT_DIR;
  const notes: string[] = [];
  if (configured && kitDir !== configured) notes.push(`The configured kit (${configured}) has no kit.config.json; showing the repository's default kit.`);

  let kit: KitConfig | null = null;
  try { kit = t.sync("kit", () => ctx.runtime.kit(kitDir).kit); } catch (e) { notes.push(`Kit could not be read: ${(e as Error).message}`); }

  const rulesFile = [path.join(kitDir, "RULES.md"), path.join(REPO_KIT_DIR, "RULES.md")].find((f) => fs.existsSync(f));
  const rulesMd = rulesFile ? fs.readFileSync(rulesFile, "utf8").trim() : "";
  const stub = isStub(rulesMd);

  let styles: TextStyle[] = [];
  if (kit) { try { styles = readTextStyles(kit); } catch (e) { notes.push((e as Error).message); } }
  const families = kit ? kitFontFamilies(kit) : null;

  const known = new Set(RULES.map((r) => r.id));
  const table = RULES.map((r) => ({ id: r.id, severity: r.severity, ...(RULE_SUMMARIES[r.id] ?? { when: "see the finding's detail", fix: "see the finding's fix" }) }));
  const missingSummaries = [...known].filter((id) => !RULE_SUMMARIES[id]);

  const lines: string[] = [
    "# Design rules for Unity UI Toolkit screens (unity-ui-mcp)",
    "",
    "Designs are HTML/CSS (Claude Design or any AI) built with the design kit. Lint enforces this contract; anything",
    "outside it fails with a rule id and a fix, and is never approximated. Fix lint errors in the design, not in Unity.",
    "",
    `Kit: ${kitDir}${kit ? ` (reference ${kit.reference.join("×")}, viewports ${kit.viewports.map((v) => v.join("×")).join(", ")}, locales ${kit.locales.join(", ")})` : ""}`,
    ...notes.map((n) => `> ${n}`),
    "",
    "## Kit rules (RULES.md)",
    "",
    stub
      ? "RULES.md in this version is a stub: the full written contract arrives with the design kit. Until then the markup attributes, text styles, fonts, allowed CSS and lint rules below are the contract (they are what lint checks)."
      : rulesMd,
    "",
    "## Markup attributes",
    "",
    "| Attribute | Meaning | Required |",
    "|---|---|---|",
    ...ATTRIBUTES.map((a) => `| \`${a.name}\` | ${a.meaning} | ${a.required} |`),
    "",
    "Ids, keys and action names are ASCII: `^[a-z0-9]+([._-][a-z0-9]+)*$`. Elements without `data-u-id` get structural names.",
    "The screen root is one element of exactly the kit reference size at (0, 0) with `body { margin: 0 }`.",
    "",
    "## Text styles (text-styles.json)",
    "",
    styles.length
      ? ["Every text uses one of these size / line-height / weight combinations exactly (U-CSS-016):", "",
        "| Style | font-size (px) | line-height (px) | font-weight |", "|---|---|---|---|",
        ...styles.map((s) => `| ${s.name} | ${s.fontSize} | ${s.lineHeight} | ${s.weight} |`)].join("\n")
      : "No text styles in this kit yet.",
    "",
    "## Font families (kit fonts)",
    "",
    families && Object.keys(families).length
      ? ["Only these families (first in every `font-family` stack, U-CSS-010); no other @font-face (U-FONT-002):", "",
        ...Object.entries(families).map(([f, w]) => `- \`${f}\`: ${w.join(", ")}`)].join("\n")
      : "No fonts synced into this kit yet (design_ui_kit_sync copies them from the Unity project).",
    "",
    "## Allowed CSS",
    "",
    allowedCssMarkdown(),
    "",
    "## Lint rules",
    "",
    "Errors (U-) block import; warnings (W-) are reported.",
    "",
    "| Rule | Severity | Fails when | Fix |",
    "|---|---|---|---|",
    ...table.map((r) => `| ${r.id} | ${r.severity} | ${r.when} | ${r.fix} |`),
  ];

  return {
    text: lines.join("\n"),
    data: {
      kitDir, rulesFile: rulesFile ?? null, rulesMdIsStub: stub,
      textStyles: styles, fontFamilies: families,
      ruleCount: RULES.length, ruleIds: RULES.map((r) => r.id), rulesWithoutSummary: missingSummaries,
      notes,
    },
  };
}

export function registerRules(server: McpServer, ctx: ServerContext): void {
  server.registerTool("design_ui_rules", {
    title: "Design rules",
    description:
      "The design contract for HTML screens that are turned into Unity UI Toolkit: kit RULES.md, required data-u-*/data-l10n " +
      "attributes, kit text styles and fonts, the allowed CSS and every lint rule with its fix. Read it once before writing or " +
      "fixing a design. Also available as the resource design-ui://rules.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const t = new Timings();
    return guarded(t, async () => {
      const r = buildRules(ctx, t);
      return toolResult(r.text, { ...r.data, timings: t.done() });
    });
  });

  server.registerResource("rules", "design-ui://rules", {
    title: "Design rules",
    description: "Same content as the design_ui_rules tool (Markdown).",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildRules(ctx, new Timings()).text }] }));
}
