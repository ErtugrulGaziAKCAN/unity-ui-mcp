import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sameProject } from "./bridge.js";
import { extractZip } from "./zip.js";

/** Per-screen bookkeeping folder: `<designRoot>/<screen>/.design-ui/` (last-import.json, last-verify.json, export/). */
export const BOOKKEEPING_DIR = ".design-ui";
export const REPORT_FILE = "report.html";

export const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

/** The design pages of a folder: its .html files (report.html excluded), sorted by name. */
export function designPages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.html$/i.test(d.name) && d.name.toLowerCase() !== REPORT_FILE)
    .map((d) => d.name)
    .sort();
}

/**
 * The design page of a screen folder: its only .html file (report.html excluded); with several, index.html, else
 * the only .dc.html (a Claude Design artboard). Otherwise the caller must name the file: the error lists the candidates,
 * as paths under `designRoot` when it is given (ready to pass as the design).
 */
export function findEntry(dir: string, designRoot?: string): string {
  const names = designPages(dir);
  if (names.length === 0) throw new Error(`no .html design in ${dir}`);
  if (names.length === 1) return path.join(dir, names[0]);
  const index = names.find((n) => n.toLowerCase() === "index.html");
  if (index) return path.join(dir, index);
  const dc = names.filter((n) => /\.dc\.html$/i.test(n));
  if (dc.length === 1) return path.join(dir, dc[0]);
  const shown = names.map((n) => (designRoot ? designPath(path.join(dir, n), designRoot) : n));
  throw new Error(`several designs in ${dir}: pass the path of the one to use: ${shown.join(", ")}`);
}

/** A path under designRoot as a design argument (forward slashes); an absolute path when it is outside. */
export function designPath(p: string, designRoot: string): string {
  const rel = path.relative(designRoot, p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? p : rel.split(path.sep).join("/");
}

/** The page an exported IR was made from (its `source.path`), else null. */
export function exportedPage(ir: Buffer): string | null {
  try {
    const p = JSON.parse(ir.toString("utf8"))?.source?.path;
    return typeof p === "string" && p.length > 0 && path.basename(p) === p ? p : null;
  } catch { return null; }
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
  if (st.isDirectory()) return { entry: findEntry(p, designRoot), zip: null, cleanup: () => {} };
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
 * A screen folder under designRoot, the screen id its pages name (data-u-screen; the bookkeeping key), and the page a
 * path named in it (null when the argument was the folder or the screen id).
 */
export interface ScreenRef { screen: string; dir: string; entry: string | null }

/** The first `data-u-screen` attribute of an element in an HTML page's markup. */
const SCREEN_ATTR = /<[A-Za-z][^>]*?\sdata-u-screen\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/;

/** The screen id a page names in its markup (data-u-screen), or null when its markup names none (a script may build it). */
export function pageScreen(file: string): string | null {
  let html: string;
  try { html = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = SCREEN_ATTR.exec(html);
  const id = m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
  return id.length > 0 ? id : null;
}

/** Each design page of a folder with the screen id its markup names (null: none), sorted by page. */
export function folderScreens(dir: string): { page: string; screen: string | null }[] {
  return designPages(dir).map((page) => ({ page, screen: pageScreen(path.join(dir, page)) }));
}

/**
 * Why a folder's pages cannot share its bookkeeping, or null: a design folder holds the artboards of one screen, so pages
 * that name different screens are refused. `pages` may carry an exported page's screen instead of its markup's.
 */
export function mixedScreens(dir: string, designRoot: string, pages = folderScreens(dir)): string | null {
  const named = pages.filter((x) => x.screen !== null);
  if (new Set(named.map((x) => x.screen)).size <= 1) return null;
  return `the pages of ${designPath(dir, designRoot)} name different screens (${named.map((x) => `${x.page} → ${x.screen}`).join(", ")}): ` +
    "a design folder holds the artboards of one screen only; move each screen's pages into a folder of their own";
}

/** The screen id a folder's last import recorded, else null. */
function recordedScreen(dir: string): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, BOOKKEEPING_DIR, "last-import.json"), "utf8"))?.screen;
    return typeof s === "string" && s.length > 0 ? s : null;
  } catch { return null; }
}

/**
 * The screen a folder holds: the one its pages name (data-u-screen); for pages whose markup names none, its last import's
 * screen, else the folder name. Throws when the pages name different screens.
 */
export function folderScreenId(dir: string, designRoot: string): string {
  const pages = folderScreens(dir);
  const mixed = mixedScreens(dir, designRoot, pages);
  if (mixed) throw new Error(mixed);
  return pages.find((x) => x.screen !== null)?.screen ?? recordedScreen(dir) ?? path.basename(dir);
}

/** Folders under designRoot that hold the screen `id` (by their pages' data-u-screen, else by their last import). */
export function screenHolders(designRoot: string, id: string): string[] {
  return screenFolders(designRoot).filter((f) => {
    const dir = path.join(designRoot, f);
    const named = folderScreens(dir).filter((x) => x.screen !== null);
    return named.length ? named.some((x) => x.screen === id) : recordedScreen(dir) === id;
  });
}

/**
 * The screen folder for import, verify and status: a folder (or a design page inside it) directly under designRoot, or a
 * screen id (the data-u-screen its pages name; a folder of that name first). The folder's pages must name one screen. A
 * page path is kept as `entry` (its name as it is on disk), so the caller uses exactly that page.
 */
export function resolveScreen(design: string, designRoot: string): ScreenRef {
  let p = resolveInput(design, designRoot);
  if (!fs.existsSync(p)) {
    // a screen id whose folder has another name
    const holders = !path.isAbsolute(design) && !/[\\/]/.test(design) ? screenHolders(designRoot, design) : [];
    if (holders.length > 1) throw new Error(`screen ${design} is in several folders under designRoot: ${holders.join(", ")}: keep each screen's artboards in one folder`);
    if (holders.length === 0) throw new Error(`screen not found: ${design} (looked for ${p} and for a folder whose pages name it)`);
    p = path.join(designRoot, holders[0]);
  }
  const isDir = fs.statSync(p).isDirectory();
  // the folder's name as it is on disk: a case-insensitive file system also opens another spelling, and the run's claim and
  // the cleanup know one folder by one name
  const dir = onDiskName(isDir ? p : path.dirname(p));
  if (!sameProject(path.dirname(dir), designRoot)) {
    throw new Error(`${dir} is not a screen folder under designRoot (${designRoot}): put the design in ${path.join(designRoot, "<screen-id>")}${path.sep} first`);
  }
  let entry: string | null = null;
  if (!isDir) {
    const base = path.basename(p);
    if (!/\.html$/i.test(p) || base.toLowerCase() === REPORT_FILE) {
      throw new Error(`${design} is not a design page: pass the screen folder or one of its .html / .dc.html pages`);
    }
    if (!sameProject(path.dirname(fs.realpathSync(p)), dir)) {
      throw new Error(`${design}: ${base} is a link to a file outside ${path.basename(dir)}; put the page itself in the screen folder`);
    }
    // the name on disk (a case-insensitive file system also opens another spelling)
    const pages = designPages(dir);
    entry = path.join(dir, pages.find((n) => n === base) ?? pages.find((n) => n.toLowerCase() === base.toLowerCase()) ?? base);
  }
  return { screen: folderScreenId(dir, designRoot), dir, entry };
}

/** `p` with its last name spelled as its folder lists it (the exact name first, else the one that differs only in case). */
function onDiskName(p: string): string {
  const parent = path.dirname(p), base = path.basename(p);
  let names: string[];
  try { names = fs.readdirSync(parent); } catch { return p; }
  if (names.includes(base)) return p;
  const same = names.filter((n) => n.toLowerCase() === base.toLowerCase());
  return same.length === 1 ? path.join(parent, same[0]) : p;
}

/** Screen folders under designRoot: subfolders (not dot folders) that contain a design page. */
export function screenFolders(designRoot: string): string[] {
  if (!fs.existsSync(designRoot)) return [];
  return fs.readdirSync(designRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => designPages(path.join(designRoot, n)).length > 0)
    .sort();
}
