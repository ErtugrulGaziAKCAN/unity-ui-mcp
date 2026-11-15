import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildKit } from "./build.js";
import { parseViewports } from "../viewport.js";

/**
 * `design-export kit upgrade <kitDir>`: brings a project's own kit (setup copies the clone's `design-kit` there, kit sync
 * writes into it) to the version of the clone the command runs from, keeping what belongs to the project.
 *
 * - Replaced with the clone's: every file the clone's kit has outside `fixtures/` and its fonts folder (base stylesheet,
 *   RULES.md, components, the text styles), and the configuration keys the clone defines.
 * - Merged: `text-styles.json` takes the clone's styles and keeps the project's own (names the clone does not define);
 *   `tokens.css` takes the clone's file and keeps every token the project changed or added; `kit.config.json` keeps the
 *   project's `locales`, `referenceLocale`, `reference`, `screenMatch` and `textSizes` (kit sync writes them from the
 *   profile), its own keys and paths, and the viewports are the clone's plus any the project declared besides.
 * - Kept as they are: the fonts folder (fonts CSS and JSON included) and every file the clone does not have.
 *
 * Everything is merged and built (`kit build`, then `kit build --check`) on a staging copy first: a merge that does not
 * build writes nothing. Then the files it replaces are backed up into `<kitDir>/.backup/<UTC time>/files/`, with
 * `kit-upgrade.json` listing the files it replaced and added (dot folders are not imported by Unity nor read by the
 * exporter), written, and the backups beyond the newest {@link KEEP_BACKUPS} are removed. `dryRun` reports the same plan and writes nothing. The staging copy is always removed.
 */
export interface KitUpgradeOptions {
  /** The kit to upgrade to: the clone's `design-kit` by default. */
  from?: string;
  dryRun?: boolean;
  /** The backup's time stamp (tests); now by default. */
  now?: Date;
  /** Where the staging copy goes (tests); the system's temporary folder by default. */
  tmpRoot?: string;
}

export interface KitUpgradeResult {
  ok: boolean;
  dryRun: boolean;
  kitDir: string;
  from: string;
  /** Files written over the project's, with the clone's content or a merge (relative to the kit, '/' separators). */
  replaced: string[];
  /** Files the project's kit did not have, added from the clone. */
  added: string[];
  /** What was kept from the project, one line each. */
  kept: string[];
  /** Other changes worth saying (a new clone token, a viewport class taken from the clone). */
  notes: string[];
  /** The backup folder, or null (a dry run, or nothing changed). */
  backup: string | null;
  /** Older backups removed. */
  pruned: string[];
  errors: string[];
}

export const KEEP_BACKUPS = 3;
export const BACKUP_DIR = ".backup";
/** Inside a backup: the old files (at their kit paths) and the manifest naming what the upgrade replaced and added. */
export const BACKUP_FILES = "files", BACKUP_MANIFEST = "kit-upgrade.json";

/** The clone's own kit: `design-kit` at the root of the repository this module belongs to. */
export function cloneKitDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../design-kit");
}

/** Whether a folder is a unity-ui-mcp clone's own `design-kit` (the MCP server and kit sync check the same). */
export function isCloneKit(dir: string): boolean {
  const full = path.resolve(dir), repo = path.dirname(full);
  return path.basename(full) === "design-kit" && fs.existsSync(path.join(repo, "packages", "com.ertugrulgaziakcan.design-ui", "package.json")) &&
    fs.existsSync(path.join(repo, "tools", "design-ui-mcp", "package.json"));
}

type Json = Record<string, unknown>;
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, "utf8")) as Json;
const rel = (p: string) => p.split(path.sep).join("/");
const sizeKey = (v: unknown) => { const s = Array.isArray(v) ? v : (v as { size: number[] }).size; return `${s[0]}×${s[1]}`; };

/** Every file under `dir` (relative, '/' separators), skipping the top-level names in `skip`. */
function files(dir: string, skip: (r: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string, r: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, d.name), q = r ? `${r}/${d.name}` : d.name;
      if (skip(q)) continue;
      if (d.isDirectory()) walk(p, q);
      else if (d.isFile()) out.push(q);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** A tokens.css declaration: its name, value (whitespace collapsed), its text as written (a value may span lines) and where it is. */
interface Decl { name: string; value: string; text: string; start: number; end: number }

/** The declarations of a tokens.css text, by declaration, not by line (a value may span several lines). */
function declarations(css: string): Decl[] {
  const out: Decl[] = [];
  for (const m of css.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;]*);[ \t]*(?:\/\*[\s\S]*?\*\/)?/g))
    out.push({ name: m[1], value: m[2].trim().replace(/\s+/g, " "), text: m[0], start: m.index!, end: m.index! + m[0].length });
  return out;
}

/**
 * Every earlier value of each token in the clone's tokens.css, from the clone's git history (empty when the kit is not in a
 * git repository or git is not available): a project value found there is one the clone changed since the project copied
 * it, not one the project changed.
 */
function cloneTokenHistory(cloneTokens: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
  try {
    const dir = path.dirname(cloneTokens);
    const root = git(dir, "rev-parse", "--show-toplevel").trim();
    const relPath = rel(path.relative(fs.realpathSync(root), fs.realpathSync(cloneTokens)));
    const shas = git(root, "log", "--format=%H", "-n", "500", "--", relPath).split("\n").filter(Boolean);
    for (const sha of shas) {
      let text: string;
      try { text = git(root, "show", `${sha}:${relPath}`); } catch { continue; }
      for (const d of declarations(text)) {
        if (!out.has(d.name)) out.set(d.name, new Set());
        out.get(d.name)!.add(d.value);
      }
    }
  } catch { /* not a git checkout: no history */ }
  return out;
}

/**
 * The project's tokens.css merged into the clone's: the clone's file, with each token the project changed (its whole
 * declaration as written) and each token of its own appended before the end of :root. A project value that is an earlier
 * value of the clone's (its git history) takes the clone's current one; any other differing value is kept and said.
 */
function mergeTokens(clone: string, project: string, history: Map<string, Set<string>>, kept: string[], notes: string[]): string {
  const theirs = declarations(project);
  const byName = new Map(theirs.map((d) => [d.name, d]));
  const mine = declarations(clone);
  const cloneNames = new Set(mine.map((d) => d.name));
  let out = clone;
  // splice from the end, so earlier positions stay valid
  for (const d of mine.slice().reverse()) {
    const p = byName.get(d.name);
    if (!p) { notes.push(`tokens.css: added the clone's token --${d.name}: ${d.value}`); continue; }
    if (p.value === d.value) continue;
    if (history.get(d.name)?.has(p.value)) { notes.push(`tokens.css: --${d.name}: ${p.value} → ${d.value} (an earlier clone value)`); continue; }
    kept.push(`tokens.css: --${d.name}: ${p.value} (kept: differs from the clone's ${d.value})`);
    out = out.slice(0, d.start) + p.text + out.slice(d.end);
  }
  const own = theirs.filter((d) => !cloneNames.has(d.name));
  if (own.length) {
    const close = out.lastIndexOf("}");
    const block = own.map((d) => `  ${d.text}`).join("\n") + "\n";
    for (const d of own) kept.push(`tokens.css: --${d.name}: ${d.value} (the project's own token)`);
    out = close >= 0 ? out.slice(0, close).replace(/[ \t]*$/, "") + block + out.slice(close) : out + "\n" + block;
  }
  return out;
}

/** components/components.json: the clone's components in its order, then each component only the project registered. */
function mergeComponents(clone: string, project: string | null, kept: string[]): string {
  if (project === null) return clone;
  type Entry = { name?: unknown };
  let theirs: Entry[] = [];
  try { theirs = ((JSON.parse(project) as { components?: Entry[] }).components ?? []).filter((c) => c && typeof c === "object"); } catch { return clone; }
  const parsed = JSON.parse(clone) as Record<string, unknown> & { components?: Entry[] };
  const names = new Set((parsed.components ?? []).map((c) => String(c.name)));
  const own = theirs.filter((c) => !names.has(String(c.name)));
  if (!own.length) return clone;
  for (const c of own) kept.push(`components/components.json: the project's component ${String(c.name)}`);
  const all = [...(parsed.components ?? []), ...own];
  const line = (e: Entry) => JSON.stringify(e).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/,"/g, ', "').replace(/":/g, '": ');
  return `{\n  "components": [\n${all.map((e) => `    ${line(e)}`).join(",\n")}\n  ]\n}\n`;
}

/** kit.config.json: the clone's keys and order, the project's profile-written keys, own keys, paths and extra viewports. */
function mergeConfig(clone: Json, project: Json, kept: string[], notes: string[]): Json {
  const PROJECT_KEYS = ["locales", "referenceLocale", "reference", "screenMatch", "textSizes", "fontsCss", "tokensCss", "textStyles"];
  const out: Json = {};
  for (const [k, v] of Object.entries(clone)) out[k] = v;
  for (const k of PROJECT_KEYS) {
    if (project[k] === undefined) continue;
    if (JSON.stringify(project[k]) !== JSON.stringify(clone[k])) kept.push(`kit.config.json: "${k}": ${JSON.stringify(project[k])} (the project's)`);
    out[k] = project[k];
  }
  for (const [k, v] of Object.entries(project)) {
    if (k in clone || PROJECT_KEYS.includes(k) || k === "viewports") continue;
    out[k] = v;
    kept.push(`kit.config.json: "${k}" (the project's own key)`);
  }
  // the clone's other keys: a list keeps the values only the project added (a union); any other value is the clone's, said
  for (const [k, v] of Object.entries(clone)) {
    if (PROJECT_KEYS.includes(k) || k === "viewports" || project[k] === undefined || JSON.stringify(project[k]) === JSON.stringify(v)) continue;
    if (k === "filterFunctions") { notes.push(`kit.config.json: "filterFunctions" follows css-support.json (kit build writes it): ${JSON.stringify(v)}`); continue; }
    if (Array.isArray(v) && Array.isArray(project[k])) {
      const seen = new Set(v.map((x) => JSON.stringify(x)));
      const extra = (project[k] as unknown[]).filter((x) => !seen.has(JSON.stringify(x)));
      out[k] = [...v, ...extra];
      if (extra.length) kept.push(`kit.config.json: "${k}" keeps the project's ${extra.map((x) => JSON.stringify(x)).join(", ")} besides the clone's`);
      continue;
    }
    notes.push(`kit.config.json: "${k}" takes the clone's ${JSON.stringify(v)} (the project had ${JSON.stringify(project[k])})`);
  }
  const cloneVps = Array.isArray(clone.viewports) ? (clone.viewports as unknown[]) : [];
  const projectVps = Array.isArray(project.viewports) ? (project.viewports as unknown[]) : [];
  const known = new Map(cloneVps.map((v) => [sizeKey(v), v]));
  const extra = projectVps.filter((v) => !known.has(sizeKey(v)));
  for (const v of extra) kept.push(`kit.config.json: viewport ${sizeKey(v)} (the project declared it besides the clone's)`);
  for (const v of projectVps) {
    const c = known.get(sizeKey(v));
    if (c !== undefined && JSON.stringify(c) !== JSON.stringify(v)) notes.push(`kit.config.json: viewport ${sizeKey(v)} takes the clone's class (${JSON.stringify(c)})`);
  }
  out.viewports = [...cloneVps, ...extra];
  parseViewports(out.viewports);
  return out;
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");

export function upgradeKit(kitDir: string, opts: KitUpgradeOptions = {}): KitUpgradeResult {
  const kit = path.resolve(kitDir), from = path.resolve(opts.from ?? cloneKitDir());
  const result: KitUpgradeResult = { ok: false, dryRun: !!opts.dryRun, kitDir: kit, from, replaced: [], added: [], kept: [], notes: [], backup: null, pruned: [], errors: [] };
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  if (!fs.existsSync(path.join(from, "kit.config.json"))) throw new Error(`${from} is not a design kit (no kit.config.json)`);
  if (!fs.existsSync(path.join(kit, "kit.config.json"))) throw new Error(`${kit} is not a design kit (no kit.config.json)`);
  if (real(kit) === real(from) || isCloneKit(kit)) throw new Error(`${kit} is the clone's own kit: upgrade the project's kit (design-ui.config.json's kitDir)`);

  const cloneCfg = readJson(path.join(from, "kit.config.json")), projectCfg = readJson(path.join(kit, "kit.config.json"));
  const str = (o: Json, k: string, d: string) => (typeof o[k] === "string" ? (o[k] as string) : d);
  const cloneFonts = path.posix.dirname(str(cloneCfg, "fontsCss", "fonts/fonts.css"));
  const projectFonts = path.posix.dirname(str(projectCfg, "fontsCss", "fonts/fonts.css"));
  const cloneStyles = str(cloneCfg, "textStyles", "text-styles.json"), projectStyles = str(projectCfg, "textStyles", "text-styles.json");
  const cloneTokens = str(cloneCfg, "tokensCss", "tokens.css"), projectTokens = str(projectCfg, "tokensCss", "tokens.css");
  const inFonts = (r: string, dir: string) => dir !== "." && (r === dir || r.startsWith(dir + "/"));

  // the staging copy: the project kit without its backups, then the clone's files and the merges
  fs.mkdirSync(opts.tmpRoot ?? os.tmpdir(), { recursive: true });
  const staging = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "design-kit-upgrade-"));
  try {
    const projectFiles = files(kit, (r) => r === BACKUP_DIR);
    for (const r of projectFiles) { fs.mkdirSync(path.dirname(path.join(staging, r)), { recursive: true }); fs.copyFileSync(path.join(kit, r), path.join(staging, r)); }
    const write = (r: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(staging, r)), { recursive: true }); fs.writeFileSync(path.join(staging, r), data); };

    for (const r of files(from, (q) => q === "fixtures" || q === BACKUP_DIR || inFonts(q, cloneFonts))) {
      if (r === "kit.config.json" || r === cloneTokens) continue;
      if (r === cloneStyles) continue;
      if (r === "components/components.json") {
        const theirs = path.join(kit, r);
        write(r, mergeComponents(fs.readFileSync(path.join(from, r), "utf8"), fs.existsSync(theirs) ? fs.readFileSync(theirs, "utf8") : null, result.kept));
        continue;
      }
      write(r, fs.readFileSync(path.join(from, r)));
    }
    if (projectFonts !== "." && fs.existsSync(path.join(kit, projectFonts))) result.kept.push(`${projectFonts}/: the project's fonts, fonts CSS and JSON (kit sync writes them)`);

    // text styles: the clone's, then the project's own
    const cs = readJson(path.join(from, cloneStyles));
    const ps = fs.existsSync(path.join(kit, projectStyles)) ? readJson(path.join(kit, projectStyles)) : {};
    const styles: Json = { ...cs };
    for (const [name, v] of Object.entries(ps)) {
      if (name in cs) {
        if (JSON.stringify(v) !== JSON.stringify(cs[name])) result.notes.push(`${projectStyles}: text style ${name} ${JSON.stringify(v)} → ${JSON.stringify(cs[name])} (the clone's)`);
      } else { styles[name] = v; result.kept.push(`${projectStyles}: text style ${name} ${JSON.stringify(v)} (the project's own)`); }
    }
    // the clone's bytes when the project has no style of its own; else one style per line, as the clone writes it
    write(projectStyles, Object.keys(styles).length === Object.keys(cs).length ? fs.readFileSync(path.join(from, cloneStyles))
      : "{\n" + Object.entries(styles).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/,"/g, ', "').replace(/":/g, '": ')}`).join(",\n") + "\n}\n");

    // tokens and configuration
    if (fs.existsSync(path.join(from, cloneTokens))) {
      const ct = fs.readFileSync(path.join(from, cloneTokens), "utf8");
      const pt = fs.existsSync(path.join(kit, projectTokens)) ? fs.readFileSync(path.join(kit, projectTokens), "utf8") : "";
      write(projectTokens, mergeTokens(ct, pt, cloneTokenHistory(path.join(from, cloneTokens)), result.kept, result.notes));
    }
    write("kit.config.json", JSON.stringify(mergeConfig(cloneCfg, projectCfg, result.kept, result.notes)) + "\n");

    // kit build, then kit build --check, on the staging copy
    let build;
    try {
      build = buildKit(staging);
      const check = buildKit(staging, { check: true });
      result.errors.push(...build.errors, ...check.errors, ...check.changed.map((c) => `kit build --check: ${c} is stale after kit build`));
      result.notes.push(...build.warnings.map((w) => `kit build: ${w}`));
    } catch (e) { result.errors.push(`kit build: ${(e as Error).message}`); }
    if (result.errors.length) return result;

    // what changes in the project's kit
    const staged = files(staging, () => false);
    for (const r of staged) {
      const target = path.join(kit, r);
      if (!fs.existsSync(target)) result.added.push(r);
      else if (!fs.readFileSync(target).equals(fs.readFileSync(path.join(staging, r)))) result.replaced.push(r);
    }
    for (const r of projectFiles) {
      if (inFonts(r, projectFonts) || r === projectTokens || r === "kit.config.json") continue;
      if (!fs.existsSync(path.join(from, r)) && !(r === projectStyles)) result.kept.push(`${r} (not in the clone's kit)`);
    }
    result.ok = true;
    if (opts.dryRun || result.replaced.length + result.added.length === 0) return result;

    // back up what changes (the old files under files/, and kit-upgrade.json naming the files it adds), write it, keep the
    // newest backups
    const backup = path.join(kit, BACKUP_DIR, stamp(opts.now ?? new Date()));
    for (const r of result.replaced) {
      fs.mkdirSync(path.dirname(path.join(backup, BACKUP_FILES, r)), { recursive: true });
      fs.copyFileSync(path.join(kit, r), path.join(backup, BACKUP_FILES, r));
    }
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, BACKUP_MANIFEST), JSON.stringify({ from, replaced: result.replaced, added: result.added }, null, 2) + "\n");
    result.backup = backup;
    for (const r of [...result.replaced, ...result.added]) {
      const target = path.join(kit, r), tmp = `${target}.upgrade-${process.pid}`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(staging, r), tmp);
      fs.renameSync(tmp, target);
    }
    const backups = fs.readdirSync(path.join(kit, BACKUP_DIR), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(kit, BACKUP_DIR, old), { recursive: true, force: true });
      result.pruned.push(path.join(kit, BACKUP_DIR, old));
    }
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
