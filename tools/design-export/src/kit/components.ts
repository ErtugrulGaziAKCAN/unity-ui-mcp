import fs from "node:fs";
import path from "node:path";

/**
 * The kit's component library (design-kit/components): `components.json` lists each component in display order with
 * its Design System name (an ASCII identifier), its screen file and its group; `<file>.md` next to the screen holds the
 * guidelines, whose first sentence is the summary.
 */
export interface KitComponent { name: string; file: string; group: string; guide: string; summary: string }

const IDENT = /^[A-Za-z][A-Za-z0-9]*$/;

/** The first sentence of a text: up to the first full stop followed by a space or the end. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?\.)(?:\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

export function readKitComponents(kitDir: string): KitComponent[] {
  const dir = path.join(path.resolve(kitDir), "components");
  const manifest = path.join(dir, "components.json");
  if (!fs.existsSync(manifest)) return [];
  const raw = JSON.parse(fs.readFileSync(manifest, "utf8")) as { components?: { name?: unknown; file?: unknown; group?: unknown }[] };
  const out: KitComponent[] = [];
  for (const c of raw.components ?? []) {
    const name = String(c.name ?? ""), file = String(c.file ?? ""), group = String(c.group ?? "");
    if (!IDENT.test(name)) throw new Error(`components.json: "${name}" is not an ASCII identifier`);
    if (out.some((o) => o.name === name)) throw new Error(`components.json: ${name} is listed twice`);
    if (!/^[a-z0-9-]+\.html$/.test(file) || !fs.existsSync(path.join(dir, file))) throw new Error(`components.json: ${name}: no file components/${file}`);
    if (!group.trim()) throw new Error(`components.json: ${name} needs a group`);
    const mdFile = path.join(dir, file.replace(/\.html$/, ".md"));
    if (!fs.existsSync(mdFile)) throw new Error(`components.json: ${name}: no guidelines components/${path.basename(mdFile)}`);
    const guide = fs.readFileSync(mdFile, "utf8").replace(/\r\n/g, "\n").trim() + "\n";
    out.push({ name, file, group, guide, summary: firstSentence(guide.split("\n\n")[0]) });
  }
  return out;
}
