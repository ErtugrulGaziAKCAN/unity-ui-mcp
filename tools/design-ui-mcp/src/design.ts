import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sameProject } from "./bridge.js";
import { extractZip } from "./zip.js";

/** Per-screen bookkeeping folder: `<designRoot>/<screen>/.design-ui/` (last-import.json, last-verify.json, export/). */
export const BOOKKEEPING_DIR = ".design-ui";
export const REPORT_FILE = "report.html";

export const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * The design page of a screen folder: its only .html file (report.html excluded); with several, index.html, else
 * the only .dc.html (a Claude Design artboard). Otherwise the caller must name the file.
 */
export function findEntry(dir: string): string {
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.html$/i.test(d.name) && d.name.toLowerCase() !== REPORT_FILE)
    .map((d) => d.name)
    .sort();
  if (names.length === 0) throw new Error(`no .html design in ${dir}`);
  if (names.length === 1) return path.join(dir, names[0]);
  const index = names.find((n) => n.toLowerCase() === "index.html");
  if (index) return path.join(dir, index);
  const dc = names.filter((n) => /\.dc\.html$/i.test(n));
  if (dc.length === 1) return path.join(dir, dc[0]);
  throw new Error(`several designs in ${dir} (${names.join(", ")}): pass the path of the one to use`);
}

/** Hash of every source file of a screen folder (path + content); bookkeeping, dotfiles and the report excluded. */
export function sourceSha(dir: string): string {
  const lines: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (!rel && d.name.toLowerCase() === REPORT_FILE) continue;
      const p = path.join(abs, d.name);
      if (d.isDirectory()) walk(p, r);
      else if (d.isFile()) lines.push(`${r}\0${sha256(fs.readFileSync(p))}`);
    }
  };
  walk(dir, "");
  return sha256(lines.sort().join("\n"));
}

export interface DesignInput {
  /** The HTML page to load (.html or .dc.html). */
  entry: string;
  /** The ZIP it came from, else null. */
  zip: string | null;
  /** Removes the temp folder of an extracted ZIP; no-op otherwise. */
  cleanup(): void;
}

const resolveInput = (design: string, designRoot: string) => (path.isAbsolute(design) ? path.resolve(design) : path.resolve(designRoot, design));

/** A design given as a screen id, a folder, an .html/.dc.html file or a .zip (relative paths are under designRoot). */
export async function openDesignInput(design: string, designRoot: string): Promise<DesignInput> {
  const p = resolveInput(design, designRoot);
  if (!fs.existsSync(p)) throw new Error(`design not found: ${design} (looked for ${p})`);
  const st = fs.statSync(p);
  if (st.isDirectory()) return { entry: findEntry(p), zip: null, cleanup: () => {} };
  if (/\.zip$/i.test(p)) {
    const x = await extractZip(p);
    try {
      let dir = x.dir;
      // a ZIP of a screen folder holds that folder: descend when it is the only thing at the top
      const top = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith(".") && d.name !== "__MACOSX");
      if (top.length === 1 && top[0].isDirectory()) dir = path.join(dir, top[0].name);
      return { entry: findEntry(dir), zip: p, cleanup: x.cleanup };
    } catch (e) {
      x.cleanup();
      throw e;
    }
  }
  if (/\.html$/i.test(p)) return { entry: p, zip: null, cleanup: () => {} };
  throw new Error(`unsupported design input ${p}: expected a folder, an .html or .dc.html file, or a .zip`);
}

/**
 * The screen folder for import, verify and status: a screen id, or a folder (or a file inside it) directly under
 * designRoot. Its name is the screen id.
 */
export function resolveScreen(design: string, designRoot: string): { screen: string; dir: string } {
  const p = resolveInput(design, designRoot);
  if (!fs.existsSync(p)) throw new Error(`screen not found: ${design} (looked for ${p})`);
  const dir = fs.statSync(p).isDirectory() ? p : path.dirname(p);
  if (!sameProject(path.dirname(dir), designRoot)) {
    throw new Error(`${dir} is not a screen folder under designRoot (${designRoot}): put the design in ${path.join(designRoot, "<screen-id>")}${path.sep} first`);
  }
  return { screen: path.basename(dir), dir };
}

/** Screen folders under designRoot: subfolders (not dot folders) that contain a design page. */
export function screenFolders(designRoot: string): string[] {
  if (!fs.existsSync(designRoot)) return [];
  return fs.readdirSync(designRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => fs.readdirSync(path.join(designRoot, n)).some((f) => /\.html$/i.test(f) && f.toLowerCase() !== REPORT_FILE))
    .sort();
}
