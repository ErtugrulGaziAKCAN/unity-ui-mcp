import type { KitConfig } from "../kit.js";
import { CSS_SUPPORT_DATA, enabledFilterFunctions } from "../lint/allowed-css.js";
import { RULES } from "../lint/index.js";
import { RULE_SUMMARIES } from "../lint/rule-table.js";
import { readTextStyles } from "../lint/text-styles.js";
import { readKitFontFiles } from "./kitFonts.js";

/**
 * The design contract as compact data for tools (design_ui_rules): every lint rule with its severity and fix, the
 * allowed CSS from css-support.json in brief, the kit's text styles from its text-styles.json and its synced fonts.
 * RULES.md is the readable form of the same sources.
 */
export interface RulesJson {
  /** `viewports`: every declared viewport; `scaledViewports`: those of class scaled (exempt from the whole-device-pixel rules). */
  kit: { reference: [number, number]; viewports: [number, number][]; scaledViewports: [number, number][]; locales: string[] };
  /** Rule id → [severity, fix], in registry order. */
  rules: Record<string, [string, string]>;
  css: {
    properties: { direct: string[]; lowered: string[]; dropped: string[]; rejected: Record<string, string> };
    units: string[]; colorFunctions: string[]; colorKeywords: string[]; valueFunctions: string[]; transformFunctions: string[];
    timing: string[]; keyframeProperties: string[]; pseudoClasses: string[]; pseudoElements: string[]; mediaFeatures: string[];
    elements: string[]; inputTypes: string[]; filterFunctions: string[];
  };
  textStyles: { name: string; fontSize: number; lineHeight: number; weight: number; class: string }[];
  /** Family → weights of the kit's synced fonts ({} before kit sync). */
  fonts: Record<string, string[]>;
}

export function rulesJson(kit: KitConfig): RulesJson {
  const d = CSS_SUPPORT_DATA;
  const props = Object.entries(d.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const by = (h: string) => props.filter(([, p]) => p.handling === h).map(([n]) => n);
  const fonts: Record<string, string[]> = {};
  for (const f of readKitFontFiles(kit) ?? []) (fonts[f.family] ??= []).push(f.style === "normal" ? f.weight : `${f.weight} ${f.style}`);
  return {
    kit: { reference: kit.reference, viewports: kit.viewports, scaledViewports: kit.scaledViewports ?? [], locales: kit.locales },
    rules: Object.fromEntries(RULES.map((r) => [r.id, [r.severity, RULE_SUMMARIES[r.id]?.fix ?? "see the finding's fix"]])),
    css: {
      properties: {
        direct: by("direct"), lowered: by("lowered"), dropped: by("dropped"),
        rejected: Object.fromEntries(props.filter(([, p]) => p.handling === "error").map(([n, p]) => [n, p.rule ?? "U-CSS-023"])),
      },
      units: d.units, colorFunctions: d.colors.functions, colorKeywords: d.colors.keywords, valueFunctions: d.valueFunctions,
      transformFunctions: d.transformFunctions, timing: [...d.timingKeywords, ...d.timingFunctions.map((f) => `${f}()`)], keyframeProperties: d.keyframeProperties,
      pseudoClasses: d.pseudoClasses, pseudoElements: d.pseudoElements, mediaFeatures: d.mediaFeatures, elements: d.elements,
      inputTypes: d.inputTypes, filterFunctions: enabledFilterFunctions(),
    },
    textStyles: readTextStyles(kit).map((s) => ({ name: s.name, fontSize: s.fontSize, lineHeight: s.lineHeight, weight: s.weight, class: `.text-${s.name}` })),
    fonts,
  };
}

/** A Markdown document's `## ` sections: id (the heading as a slug), title and text (heading included). */
export interface RulesSection { id: string; title: string; text: string }

export function splitSections(md: string): RulesSection[] {
  const out: RulesSection[] = [];
  const lines = md.split("\n");
  let cur: RulesSection | null = null;
  let fence = false;
  for (const line of lines) {
    if (line.startsWith("```")) fence = !fence;
    if (!fence && line.startsWith("## ")) {
      if (cur) out.push(cur);
      const title = line.slice(3).trim();
      cur = { id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), title, text: line };
    } else if (cur) cur.text += "\n" + line;
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, text: s.text.trimEnd() }));
}
