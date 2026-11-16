import type { KitConfig } from "../kit.js";
import { viewportClassOf } from "../viewport.js";
import { CSS_SUPPORT_DATA, CSS_SUPPORT_JSON, enabledFilterFunctions, type CssSupportData, type PropertySupport } from "../lint/allowed-css.js";
import { RULES } from "../lint/index.js";
import { RULE_SUMMARIES } from "../lint/rule-table.js";
import { readTextStyles, type TextStyle } from "../lint/text-styles.js";
import { renderBaseCss } from "./baseCss.js";
import { readKitComponents, type KitComponent } from "./components.js";
import { dsFontNotes, selectDsFonts } from "./kitFonts.js";
import { minimumKitTextPx, minimumTextPx, smallestViewport, TEXT_FLOOR_PX } from "./textStyles.js";
import { readKitTokens, type KitToken, type TokenFamily } from "./tokens.js";

/**
 * The design contract as Markdown, generated from the kit and the lint's own data so it cannot drift from what lint
 * checks: `kit` is design-kit/RULES.md (kit build writes it), `claude` is the Claude Design System's README.md (kit
 * claude writes it), which adds the artboard rules, the kit stylesheet with the tokens, the font files and the
 * component cards.
 */
export type RulesAudience = "kit" | "claude";
/** `allFaces`: the Claude export ships every face of the kit fonts (kit claude --all-faces). */
export interface RulesOptions { title?: string; allFaces?: boolean }

export const DEFAULT_TITLE = "Unity UI Kit";

/** Markup contract (spec §5.2). */
export const MARKUP_ATTRIBUTES: { name: string; meaning: string; required: string }[] = [
  { name: "data-u-screen", meaning: "Screen id on the root element, e.g. `club.overview`", required: "yes, exactly once" },
  { name: "data-u-id", meaning: "Stable element name exposed to code", required: "on every interactive, bound or action element" },
  { name: "data-l10n", meaning: "Localization key in meaningful English, e.g. `club.overview.title`", required: "on every visible static text" },
  { name: "data-en", meaning: "English source text for that key (the element's own text is the reference-locale text; with the reference locale `en` the visible text is the English entry, so `data-en` is left out or repeats it exactly, U-MRK-014)", required: "with `data-l10n` (optional with the reference locale `en`)" },
  { name: "data-u-arg", meaning: "On a `<span>` inside localized text: a Smart String argument with sample text; `data-en` writes it as `{name}`", required: "when the text has variables" },
  { name: "data-l10n-args", meaning: "Smart String argument names, e.g. `amount,currency`", required: "optional" },
  { name: "data-l10n-<attr>, data-en-<attr>", meaning: "Key and English text for `placeholder`, `title`, `alt`, `aria-label` (with the reference locale `en`, `data-en-<attr>` as `data-en`)", required: "when such an attribute has text" },
  { name: "data-u-bind", meaning: "Dynamic, non-translated value (player name, number); the element's text is sample data", required: "for runtime values" },
  { name: "data-u-action", meaning: "Command raised on activation, e.g. `open-inbox`", required: "on actionable elements" },
  { name: "data-u-repeat", meaning: "Repeated item template, e.g. `players`; the written-out samples follow it", required: "on the first sample item" },
  { name: "data-u-repeat-mode", meaning: "`list` (virtualized, the default inside a scroll area) or `inline`", required: "optional" },
  { name: "data-u-state", meaning: "Screen state variant root, e.g. `loading`, `empty`, `error`; CSS shows it under `.state-<name>`", required: "on state roots" },
  { name: "data-u-external", meaning: "Region drawn by the host (e.g. an existing uGUI shell); not compiled, masked in comparison", required: "optional" },
];

/** What the base stylesheet does, for both audiences. */
const BASE_WHAT = "It turns on grayscale font smoothing on the root (`-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`), " +
  "so browsers on macOS draw glyph stems as thin as UI Toolkit does (lint requires it on every text, U-CSS-038); writes out every browser default lint would report (U-CSS-026); " +
  "sizes every box as `border-box` (U-CSS-036); sets the kit font with the `label` style as the page default; and defines one class per text style.";

const code = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(", ");
const cell = (s: string) => s.replace(/\|/g, "\\|");

/** The allowed-CSS whitelist (css-support.json as the lint reads it), grouped by how the compiler handles each property. */
export function allowedCssMarkdown(d: CssSupportData = CSS_SUPPORT_DATA): string {
  const props = Object.entries(d.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const describe = ([name, p]: [string, PropertySupport]) => {
    const parts: string[] = [];
    if (p.keywords?.length) parts.push(p.keywords.join(" | "));
    if (p.types?.length) parts.push(`<${p.types.join(" | ")}>`);
    const fns = CSS_SUPPORT_JSON.properties[name]?.functions ?? [];
    if (fns.length) parts.push(fns.map((f) => `${f}()`).join(" | "));
    const values = parts.length ? `: ${parts.join(" or ")}` : "";
    const rule = p.rule ? ` (${p.rule})` : "";
    return `- \`${name}\`${values}${p.list ? " (comma list)" : ""}${rule}`;
  };
  // constrained properties one per line with their values; properties that take any value in one line
  const group = (h: string) => {
    const list = props.filter(([, p]) => p.handling === h);
    const free = list.filter(([, p]) => !p.keywords?.length && !p.types?.length && !p.rule && !p.list).map(([n]) => `\`${n}\``);
    return [...list.filter(([, p]) => p.keywords?.length || p.types?.length || p.rule || p.list).map(describe), ...(free.length ? [`- any value: ${free.join(", ")}`] : [])];
  };
  const errors = [`- ${props.filter(([, p]) => p.handling === "error").map(([n, p]) => `\`${n}\` (${p.rule ?? "U-CSS-023"})`).join(", ")}: the rule's fix is in the lint table`];
  return [
    "Lint is a whitelist generated from the same data the Unity style mapper reads (`css-support.json`): anything not listed here fails (U-CSS-023 for properties, keywords and units, U-CSS-024 for value functions).",
    "Properties are listed as longhands; shorthands (`margin`, `padding`, `border`, `flex`, `gap`, `inset`, `overflow`, `transition`, `animation`, `background`, `list-style`) are fine when every longhand they set is allowed.",
    "",
    "**Written to USS as is:**", "", ...group("direct"), "",
    "**Rewritten by the compiler or the exporter (allowed):**", "", ...group("lowered"), "",
    "**Accepted and left out of USS (baked by the exporter, or no effect in UI Toolkit):**", "", ...group("dropped"), "",
    "**Never supported:**", "", ...errors, "",
    `**Units:** ${code(d.units)}. **Colours:** hex, ${code(d.colors.functions.map((f) => `${f}()`))}, keywords ${code(d.colors.keywords)}.`,
    `**Value functions:** ${code(d.valueFunctions.map((f) => `${f}()`))}. **Transform functions:** ${code(d.transformFunctions)}.`,
    `**Timing functions:** ${code(d.timingKeywords)}, ${code(d.timingFunctions.map((f) => `${f}()`))}. **Keyframe properties:** see Animation.`,
    `**Pseudo-classes:** ${code(d.pseudoClasses.map((c) => `:${c}`))}. **Pseudo-elements:** ${code(d.pseudoElements.map((e) => `::${e}`))} (\`::before\`/\`::after\` only without content).`,
    `**At-rules:** ${Object.entries(d.atRules).map(([n, w]) => `\`@${n}\`${w === "kit" ? " (kit files only)" : ""}`).join(", ")}; \`@media\` features ${code(d.mediaFeatures)}, media types ${code(d.mediaTypes)}.`,
    `**Elements:** ${code(d.elements)}, inline \`<svg>\` (exported as a vector image; SVG presentation attributes allowed inside). **\`<input>\` types:** ${code(d.inputTypes)}.`,
  ].join("\n");
}

/** The kit tokens as one `:root` block (literal values, usage notes as comments). */
export function tokensCssBlock(tokens: readonly KitToken[]): string {
  return [":root {", ...tokens.map((t) => `  --${t.name}: ${t.value}; /* ${t.usage} */`), "}"].join("\n");
}

const FAMILY_TITLE: Record<TokenFamily, string> = { color: "Colours", spacing: "Spacing", radius: "Radii", shadow: "Shadows", font: "Font families" };

function tokensMarkdown(tokens: readonly KitToken[]): string {
  const out: string[] = [];
  for (const fam of ["color", "spacing", "radius", "shadow", "font"] as TokenFamily[]) {
    const list = tokens.filter((t) => t.family === fam);
    if (!list.length) continue;
    out.push(`**${FAMILY_TITLE[fam]}**`, "", "| Token | Value | Use |", "|---|---|---|",
      ...list.map((t) => `| \`--${t.name}\` | \`${cell(t.value)}\` | ${cell(t.usage)} |`), "");
  }
  return out.join("\n").trimEnd();
}

function textStylesMarkdown(styles: readonly TextStyle[], kit: KitConfig): string {
  const weights = Array.from(new Set(styles.map((s) => s.weight))).sort((a, b) => a - b);
  const smallest = smallestViewport(kit);
  return [
    "Every text uses exactly one of these size / line-height / weight combinations (U-CSS-016). Use the class: it sets all three.",
    "",
    "| Style | Class | font-size (px) | line-height (px) | font-weight |",
    "|---|---|---|---|---|",
    ...styles.map((s) => `| ${s.name} | \`.text-${s.name}\` | ${s.fontSize} | ${s.lineHeight} | ${s.weight} |`),
    "",
    "UI Toolkit cannot set a line height, so the kit's Unity font twins carry each style's CSS line box (whole pixels at every exact viewport): " +
    `a text block is exactly lines × line height tall on both sides. Weights are ${weights.join(" and ")} only, ` +
    "each with a real face in the reference locale's font (U-FONT-001); no italic unless the kit font has an italic face. Inside one line of text, " +
    "`<b>`/`<strong>` and `<span>` with another colour or kit size are rich text; `<br>` breaks the line. The table is `text-styles.json`; " +
    "every listing of it (this table, the base stylesheet's classes, the design system's type styles) is generated from that file.",
    "",
    `Readable-text floor: no text draws below ${TEXT_FLOOR_PX} device px at any declared viewport, exact or scaled. The smallest is ` +
    `${smallest.viewport[0]}×${smallest.viewport[1]} (scale ${smallest.scale}), so design text is at least ${minimumTextPx(kit)}px ` +
    `(${minimumKitTextPx(kit)}px is the smallest size that is whole device px at every exact viewport), also after a transform ` +
    "that scales it down. Lint U-FONT-004 rejects smaller text; kit build rejects a smaller text style.",
  ].join("\n");
}

function lintTable(): string {
  return [
    "Errors (`U-`) block export and import; warnings (`W-`) and information (`I-`) are reported. Each finding names the element, the declaration and a detailed fix.",
    "",
    "| Rule | Severity | Fails when | Fix |",
    "|---|---|---|---|",
    ...RULES.map((r) => {
      const s = RULE_SUMMARIES[r.id] ?? { when: "see the finding's detail", fix: "see the finding's fix" };
      return `| ${r.id} | ${r.severity} | ${s.when} | ${s.fix} |`;
    }),
  ].join("\n");
}

function componentsMarkdown(list: readonly KitComponent[], audience: RulesAudience): string {
  if (!list.length) return "The kit has no components yet.";
  const groups = Array.from(new Set(list.map((c) => c.group)));
  const out: string[] = [
    audience === "claude"
      ? "Each component card shows a lint-clean screen of the component in its states; copy its markup and classes, then adapt the content. Read the card's guidelines first."
      : "Each component is a lint-clean screen in `components/` with its guidelines next to it (`<name>.md`); copy its markup and classes, then adapt the content.",
    "",
  ];
  for (const g of groups) {
    out.push(`**${g}**`, "");
    for (const c of list.filter((x) => x.group === g)) {
      out.push(audience === "claude"
        ? `- **${c.name}** (\`components/${c.name}/README.md\`): ${c.summary}`
        : `- **${c.name}** (\`components/${c.file}\`): ${c.summary}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** The kit stylesheet a Claude Design artboard pastes into its style: the tokens, then the base stylesheet. */
export function kitStylesheetFrom(tokens: readonly KitToken[], styles: readonly TextStyle[]): string {
  return `${tokensCssBlock(tokens)}\n${renderBaseCss(styles).trimEnd()}`;
}

const EXAMPLE_CSS = [
  ".screen { display: flex; flex-direction: column; width: 2560px; height: 1440px; position: relative; padding: 64px; background-color: var(--color-surface-900); }",
  ".heading { margin-bottom: 32px; }",
  ".start { display: flex; flex-direction: row; align-items: center; justify-content: center; height: 64px; padding: 0 32px; margin-bottom: 32px; align-self: flex-start; border-radius: var(--radius-md); background-color: var(--color-accent); color: var(--color-on-accent); }",
  ".start:hover { background-color: var(--color-accent-hover); }",
  ".list { display: flex; flex-direction: column; width: 960px; height: 480px; overflow-y: auto; border-radius: var(--radius-lg); background-color: var(--color-surface-800); }",
  ".row { display: flex; flex-direction: row; align-items: center; justify-content: space-between; height: 72px; flex-shrink: 0; padding: 0 24px; }",
  ".row.is-selected { background-color: var(--color-surface-500); }",
  ".loading { display: none; color: var(--color-text-secondary); }",
  ".state-loading .loading { display: flex; }",
  ".state-loading .list { display: none; }",
];
const EXAMPLE_BODY = [
  '<div class="screen" data-u-screen="squad.overview">',
  '  <h1 class="heading text-headline-bold" data-l10n="squad.overview.title" data-en="Squad">Squad</h1>',
  '  <button class="start text-body-bold" data-u-id="start" data-u-action="start-training" data-l10n="squad.overview.start" data-en="Start training">Start training</button>',
  '  <div class="list" data-u-id="players">',
  '    <div class="row is-selected" data-u-repeat="players" data-u-id="player" data-u-action="open-player">',
  '      <span class="text-body-bold" data-u-id="name" data-u-bind="player.name">Robin Hale</span>',
  '      <span class="text-body" data-u-id="rating" data-u-bind="player.rating">8.4</span>',
  "    </div>",
  '    <div class="row" data-u-id="player" data-u-action="open-player">',
  '      <span class="text-body-bold" data-u-id="name" data-u-bind="player.name">Casey Moreno</span>',
  '      <span class="text-body" data-u-id="rating" data-u-bind="player.rating">7.9</span>',
  "    </div>",
  "  </div>",
  '  <p class="loading text-body" data-u-state="loading" data-l10n="squad.overview.loading" data-en="Loading players…">Loading players…</p>',
  "</div>",
];

/** The line of the example that stands for the stylesheet shown above it (no second copy in the document). */
export const EXAMPLE_STYLESHEET_LINE = (audience: RulesAudience) =>
  `/* paste the ${audience === "claude" ? "kit stylesheet" : "base stylesheet"} from above here, unchanged */`;

function example(audience: RulesAudience): string {
  const stylesheet = EXAMPLE_STYLESHEET_LINE(audience);
  if (audience === "kit") {
    return ["<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">', "<title>squad.overview</title>", "<style>",
      stylesheet, ...EXAMPLE_CSS, "</style>", "</head>", "<body>", ...EXAMPLE_BODY, "</body>", "</html>"].join("\n");
  }
  return ["<!doctype html>", '<html><head><meta charset="utf-8"><script src="./support.js"></script></head><body>', "<x-dc>",
    "<helmet><style>", stylesheet, ...EXAMPLE_CSS, "</style></helmet>", ...EXAMPLE_BODY, "</x-dc>",
    `<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":2560,"height":1440}}'>class Component extends DCLogic { renderVals() { return {}; } }</script>`,
    "</body></html>"].join("\n");
}

export function renderRules(kit: KitConfig, audience: RulesAudience, opts: RulesOptions = {}): string {
  const styles = readTextStyles(kit);
  let tokens: KitToken[] = [], tokenProblem: string | null = null;
  try { tokens = readKitTokens(kit); } catch (e) { tokenProblem = (e as Error).message; }
  const components = readKitComponents(kit.dir);
  const base = renderBaseCss(styles).trimEnd();
  const [rw, rh] = kit.reference;
  const ref = `${rw}×${rh}`;
  const label = (v: [number, number]) => `${v[0]}×${v[1]}`;
  const scaled = kit.viewports.filter((v) => viewportClassOf(kit.scaledViewports, v) === "scaled");
  const exact = kit.viewports.filter((v) => viewportClassOf(kit.scaledViewports, v) === "exact");
  const viewports = exact.map(label).join(", ") + (scaled.length
    ? ` (exact: every kit value is whole device px there) and ${scaled.map(label).join(", ")} (scaled: no design value is whole there; laid out and verified within ±1 device px)`
    : "");
  const claude = audience === "claude";
  const filters = enabledFilterFunctions();
  const fontTokens = tokens.filter((t) => t.family === "font");
  const fontVar = fontTokens[0] ? `var(--${fontTokens[0].name})` : "the kit family";
  const L: string[] = [];
  const h = (t: string) => L.push("", `## ${t}`, "");

  if (claude) {
    L.push(`# ${opts.title ?? DEFAULT_TITLE}`, "",
      "This design system is the contract for screens that are compiled into Unity UI Toolkit and verified against the design pixel for pixel. " +
      "Every artboard you draw with it is linted: anything outside this contract fails with a rule id and a fix and is never approximated. " +
      "Read this README first, then the card of each component you use.");
  } else {
    L.push("# Design kit rules", "",
      "The contract for HTML screens (from Claude Design or any other source) that the pipeline compiles into Unity UI Toolkit and verifies against " +
      "the design pixel for pixel. Lint enforces every rule below: anything outside the contract fails with a rule id and a fix, and is never approximated. " +
      "This file is generated by `design-export kit build` from the kit and the lint's own data; edit the sources, not this file.");
  }

  h("A screen in brief");
  L.push(
    `1. One ${claude ? "artboard" : "page"} per screen. Its root element carries \`data-u-screen="<screen.id>"\` and is exactly ${ref} px (\`width: ${rw}px; height: ${rh}px\`) at (0, 0), \`position: relative\`. Screens are verified at ${viewports}.`,
    `2. The style starts with the ${claude ? "kit stylesheet (tokens and base stylesheet, below)" : "base stylesheet (`base.css`, below)"}; it sizes boxes as UI Toolkit does and writes out every browser default.`,
    "3. Lay out with flex only. Colours, spacing, radii and shadows come from the tokens through `var(--name)`.",
    "4. Every text uses a kit text style class (`.text-body`, `.text-title-bold`, …) and the kit font; never declare `@font-face`.",
    `5. Visible text is written in the reference locale (${kit.referenceLocale ?? kit.locales[0] ?? "the first locale"}: the Unity project's choice, its DesignUiProfile's Reference Locale, which kit sync writes into the kit) with a \`data-l10n\` key and the English \`data-en\` (with the reference locale \`en\` the visible text is the English String Table entry: leave \`data-en\` out, or repeat the visible text exactly, U-MRK-014); runtime values use \`data-u-bind\` and sample text.`,
    "6. Interactive, bound and action elements carry `data-u-id`; actions name a command in `data-u-action`.",
    "7. Interaction states are `:hover`, `:active`, `:focus`, `:disabled`, `:checked` and `is-*` classes; screen states are `data-u-state` roots shown under `.state-<name>`.",
    "8. Every screen is linted before it goes to Unity (`design_ui_lint` in the MCP server, or `design-export lint <screen> --kit <kit>`); fix the design, never the generated Unity files.",
  );

  h(claude ? "Claude Design artboards" : "Claude Design canvases");
  L.push(
    ...(claude ? [] : ["When a screen is drawn in Claude Design, the kit is attached as a Design System and each screen is one artboard:", ""]),
    `- One artboard per screen, titled with the screen id, with a fixed ${ref} root; states stay \`data-u-state\` roots inside it.`,
    "- Markup goes inside `<x-dc>`, page styles inside `<helmet><style>`; start that style with the kit stylesheet.",
    "- No `{{…}}` holes (U-DC-001), no `<sc-for>`, `<sc-if>`, `<dc-import>` or `x-import` (U-DC-002), no UI built by script (U-DC-003), and no `data-props` other than `$preview` (U-DC-004).",
    "- Repeated rows are written out as sample rows, with `data-u-repeat` on the first; the samples share its structure. A later row may leave a nested list empty: write no items in it (a day without events); the first row writes at least one.",
    "- A sample row may hide an element other rows show (an untimed event's time) with the `hidden` attribute or an inline `display: none`: that is sample data. The element compiles as shown, from its own rules, and its item view gets `Set<Id>Visible`, so give it a `data-u-id` (U-MRK-003). An element hidden in every row, or hidden by a class or state, keeps that. A whole sample row is never hidden: leave it out, and for an empty nested list write no items in that row (U-MRK-013).",
    "- Inline styles are allowed; they compile like rules.",
    "- Images are uploads (`/_blob/<id>`) or inline `<svg>`; nothing is loaded from the network (U-NET-001). Fonts come only from the kit.",
  );

  h(claude ? "Kit stylesheet" : "Base stylesheet");
  L.push(
    claude
      ? `Paste this unchanged at the top of every artboard's \`<helmet><style>\`: the tokens, then the base stylesheet. ${BASE_WHAT}`
      : `\`base.css\` (generated from \`text-styles.json\`). Copy it unchanged to the top of every screen's style. ${BASE_WHAT} The kit's tokens (\`tokens.css\`) are loaded by the exporter; a Claude Design artboard pastes them too.`,
    "", "```css", claude ? kitStylesheetFrom(tokens, styles) : base, "```",
  );

  h("Markup attributes");
  L.push("| Attribute | Meaning | Required |", "|---|---|---|",
    ...MARKUP_ATTRIBUTES.map((a) => `| \`${a.name}\` | ${a.meaning} | ${a.required} |`), "",
    "Ids, actions, binds, repeat names and state names are lowercase ASCII: `^[a-z0-9]+([._-][a-z0-9]+)*$`. Localization keys are ASCII in any letter case, exact and case-sensitive, spelled as the String Table key (`inbox.main.unreadOnly`): `^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$` (both U-MRK-005; no `İ`, `ı`, `ş`). Elements without `data-u-id` get structural names, so code never depends on them.",
    "A variable inside localized text is `<span data-u-arg=\"name\">sample</span>`, written `{name}` in `data-en`.");

  h("Text styles");
  L.push(textStylesMarkdown(styles, kit));

  h("Fonts");
  if (claude) {
    const selection = selectDsFonts(kit, { allFaces: opts.allFaces });
    const faces = selection.shipped;
    const fams = Array.from(new Set(faces.map((f) => f.family)));
    const left = dsFontNotes(selection);
    L.push(`The fonts come from the Unity project (kit sync copies the font files Unity renders with), so the design renders with the same glyphs as Unity. Use \`font-family: ${fontVar}\` (the base stylesheet sets it on the page); never declare \`@font-face\` (U-FONT-002) and never name another family (U-CSS-010).`,
      "", "| Family | Weight | Style | File |", "|---|---|---|---|",
      ...faces.map((f) => `| ${f.family} | ${f.weight} | ${f.style} | \`${f.file.replace(/^.*\//, "fonts/")}\` |`), "",
      `Families: ${fams.map((f) => `"${f}"`).join(", ") || "none"}. A character the kit font lacks fails lint (U-FONT-003) instead of falling back to another font.`,
      ...(left.length ? ["", "Not in this design system (the project's kit and Unity keep them; lint and export use the kit's own files):", ...left.map((l) => `- ${l[0].toUpperCase()}${l.slice(1)}.`)] : []));
  } else {
    L.push(`The fonts come from the Unity project: kit sync copies the font files the project's TMP setup renders each locale with into \`fonts/\` and writes \`fonts/fonts.css\` and \`fonts/fonts.json\`. The exporter loads only those. Use \`font-family: ${fontVar}\` (the base stylesheet sets it on the page); never declare \`@font-face\` (U-FONT-002) and never name another family (U-CSS-010). A character the kit font lacks fails lint (U-FONT-003) instead of falling back to another font.`);
  }

  h("Tokens");
  L.push(claude
    ? "The same names and values as the kit's `tokens.css` (and `tokens.json` here); write them as `var(--name)` so a token change reaches every screen."
    : "`tokens.css`: one token per line with its use as a comment; the prefix sets the family (`color-`, `space-`, `radius-`, `shadow-`, `font-`). Write them as `var(--name)`; the exporter records the tokens a screen uses and the compiler writes them to `DesignTokens.uss`.",
  "", tokenProblem ? `The kit's tokens could not be listed: ${tokenProblem}.` : tokensMarkdown(tokens));

  h("Layout");
  L.push(
    "- `display: flex` (rows and columns, `flex-wrap: wrap` for tiles; no `wrap-reverse`) or `none`; `display: block` becomes a flex column. No grid (U-CSS-001), no floats or `position: fixed/sticky` (U-CSS-017).",
    "- `gap` only on containers that do not wrap (U-CSS-011); it becomes margins. Sizes in px or %; no `calc()` (U-CSS-005) and no viewport units (U-CSS-006).",
    "- `position: absolute` needs a positioned parent (U-CSS-035); `z-index` only where the markup order already gives the paint order (U-CSS-004, U-CSS-032).",
    "- Give flex items an explicit size or `flex-shrink: 0` where their content must not shrink (U-CSS-019); `align-items: baseline` is not available (U-CSS-018).",
    "- `min-width`, `max-width`, `min-height` and `max-height` work as in CSS, except that a box whose width `max-width` sets while its text wraps needs a width of its own (U-CSS-045): UI Toolkit sizes it to its longest line.",
    "- Move, turn and scale with `translate`, `rotate`, `scale` (or a `transform` of those functions in that order, U-CSS-025).",
    "- Text sits in its own element: no text next to element children (U-CSS-030); a single inline child of a block becomes a block only when it renders the same (U-CSS-009).",
    "- Lines break between words only: keep every word shorter than its box (`overflow-wrap` stays `normal`); `white-space: nowrap` with `overflow: hidden` and `text-overflow: ellipsis` shortens a line with an ellipsis.",
    "- `overflow: hidden` clips; `overflow-y: auto` makes a scroll area (a `ScrollView`), and a `data-u-repeat` list inside one becomes a virtualized `ListView`.",
  );

  h("Interaction and screen states");
  L.push(
    "- `:hover`, `:active`, `:focus`, `:disabled` and `:checked` on the element itself or on an ancestor (`.card:hover .title`). UI Toolkit presses one element at a time and focuses one element at a time, so style a press or focus on one element of a chain, not on both an ancestor and the element (U-CSS-033).",
    "- Custom states are `is-*` classes the generated view toggles (`.tab.is-selected`); screen states are `.state-<name>` on the screen root, with the state's content in a `data-u-state` root. Mark the initial state in the markup.",
    "- No sibling combinators, `:nth-*`, `:first-child`, `:not()` or `:has()` (U-CSS-003, U-CSS-027). A `gap` container whose earlier child hides itself by its own state is U-CSS-034.",
    "- Every state, pseudo-state and class layer is captured and compared on its own, also when it changes only a shadow or a gradient.",
  );

  h("Effects");
  L.push(
    "- `box-shadow` (outer and `inset`, several per element) is baked by the exporter into a 9-slice image per style layer. An inset shadow cannot sit on an element with its own text, on a form control or on a scroll area (U-CSS-037); put it on a wrapper.",
    "- `linear-gradient()` and `radial-gradient()` are baked into a vector image that fills the element; colour stops at least 1/64 of the gradient line apart (U-CSS-022), sRGB stops only (U-CSS-014). One background image per element (U-CSS-037).",
    "- `text-shadow`: one shadow, `x y blur colour` (several are U-CSS-023). `border-style`: `solid` or `none` (U-CSS-021). Corner radii are circular, one px value per corner (U-CSS-020; % only on squares, a pill uses half the height).",
    "- `object-fit`: `fill`, `contain` or `cover`, centred, on images. Icons are inline `<svg>`: paint every shape with `currentColor` to follow the text colour in every state, or every shape with fixed colours (U-CSS-031).",
    "- A url() background image is drawn with its CSS `background-size`, `background-position` and `background-repeat` (not `space` or `round`). Export raster images (`<img>` or background) with as many pixels as they are drawn at the largest declared viewport (their CSS size × 1.5 with 3840×2160; W-IMG-001 warns otherwise) and give them that CSS size (an `<img>` width and height, a `background-size`), not their natural size; put a scaled or repeated background image on whole pixels at every viewport (sizes and offsets in multiples of 4 px): Chromium and UI Toolkit resample a picture drawn larger than its pixels, or off the grid, differently.",
    `- \`filter\`: only the functions css-support.json enables, each once its fidelity fixture passes in Unity (U-CSS-015; \`kit.config.json\` \`filterFunctions\` mirrors the list); currently ${filters.length ? code(filters) : "none"}. No \`backdrop-filter\` (U-CSS-007), no \`outline\` (draw focus with a border).`,
  );

  h("Animation");
  L.push(
    "- Transitions and `@keyframes` are recorded with their trigger (the screen opening, a screen state, a pseudo-state or an `is-*` class) and played by the package's animation player, never as USS transitions.",
    `- Timing: the keywords, \`cubic-bezier()\` (x 0–1) or \`steps()\`; no \`linear()\` points (U-CSS-008). Keyframes and transitions animate only transforms, \`opacity\` (one-part elements, U-CSS-039), colours and border radii (U-CSS-013, U-CSS-042): a size or position change is a \`translate\` or \`scale\`, never a layout property; \`box-shadow\` or \`background-image\` fails (U-CSS-014). One property of an element is animated by keyframes or by a transition, not both (U-CSS-043).`,
    "- Verification samples each animation at its delay and every quarter of its duration. A trigger the artboard starts in (`is-open` in the markup) shows its end state.",
  );

  h("Allowed CSS");
  L.push(allowedCssMarkdown());

  h("Lint rules");
  L.push(lintTable());

  h("Components");
  L.push(componentsMarkdown(components, audience));

  h("Example");
  L.push(claude ? "A complete artboard (`.dc.html`); with the kit stylesheet pasted at the marked line it lints clean:"
    : "A complete screen; with the base stylesheet pasted at the marked line it lints clean:", "", "```html", example(audience), "```");

  return L.join("\n") + "\n";
}
