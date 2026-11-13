import fs from "node:fs";
import path from "node:path";
import { readKit } from "../kit.js";
import { readTextStyles } from "../lint/text-styles.js";
import { renderBaseCss, withBaseBlock } from "./baseCss.js";
import { renderRules } from "./rulesDoc.js";

/**
 * Kit build: regenerates what the kit derives from its sources and the lint's data, so nothing drifts:
 * `base.css` (from text-styles.json), `RULES.md` (from the tokens, text styles, components, css-support.json and the
 * rule table) and the kit base block in every component and fixture page. `check` writes nothing and only reports.
 */
export interface KitBuildResult { changed: string[] }

/** HTML pages under a folder (recursive), sorted. */
function pages(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return pages(p);
    return d.isFile() && d.name.endsWith(".html") ? [p] : [];
  }).sort();
}

export function buildKit(kitDir: string, opts: { check?: boolean } = {}): KitBuildResult {
  const kit = readKit(kitDir);
  const base = renderBaseCss(readTextStyles(kit));
  const outputs: [string, string][] = [
    ["base.css", base],
    ["RULES.md", renderRules(kit, "kit")],
  ];
  for (const file of [...pages(path.join(kit.dir, "components")), ...pages(path.join(kit.dir, "fixtures"))]) {
    const next = withBaseBlock(fs.readFileSync(file, "utf8"), base);
    if (next !== null) outputs.push([path.relative(kit.dir, file).split(path.sep).join("/"), next]);
  }
  const changed: string[] = [];
  for (const [rel, text] of outputs) {
    const file = path.join(kit.dir, rel);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue;
    changed.push(rel);
    if (!opts.check) fs.writeFileSync(file, text);
  }
  return { changed: changed.sort() };
}
