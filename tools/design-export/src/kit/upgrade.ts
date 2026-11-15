import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * build writes nothing. Then the files that change are backed up into `<kitDir>/.backup/<UTC time>/` (dot folders are
 * not imported by Unity nor read by the exporter), written, and the backups beyond the newest {@link KEEP_BACKUPS} are
 * removed. `dryRun` reports the same plan and writes nothing. The staging copy is always removed.
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
  /** Files written with the clone's content or a merge (relative to the kit, '/' separators). */
  replaced: string[];
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

/** The project's tokens.css merged into the clone's: the clone's file, with the project's changed and own tokens. */
function mergeTokens(clone: string, project: string, kept: string[], notes: string[]): string {
  const DECL = /^(\s*)--([A-Za-z0-9_-]+)\s*:\s*([^;]*);(.*)$/;
  const projectLines = new Map<string, { line: string; value: string }>();
  const projectOrder: string[] = [];
  for (const line of project.split(/\r?\n/)) {
    const m = DECL.exec(line);
    if (m) { projectLines.set(m[2], { line, value: m[3].trim().replace(/\s+/g, " ") }); projectOrder.push(m[2]); }
  }
  const cloneNames = new Set<string>();
  const out: string[] = [];
  for (const line of clone.split(/\r?\n/)) {
    const m = DECL.exec(line);
    if (!m) { out.push(line); continue; }
    cloneNames.add(m[2]);
    const p = projectLines.get(m[2]);
    if (!p) { notes.push(`tokens.css: added the clone's token --${m[2]}: ${m[3].trim()}`); out.push(line); continue; }
    if (p.value === m[3].trim().replace(/\s+/g, " ")) { out.push(line); continue; }
    kept.push(`tokens.css: --${m[2]}: ${p.value} (the project's value; the clone's is ${m[3].trim()})`);
    out.push(`${m[1]}${p.line.trimStart()}`);
  }
  const own = projectOrder.filter((n) => !cloneNames.has(n));
  if (own.length) {
    const close = out.lastIndexOf(out.slice().reverse().find((l) => /^\s*\}\s*$/.test(l)) ?? "}");
    const indent = DECL.exec(out.find((l) => DECL.test(l)) ?? "  --x: 0;")?.[1] ?? "  ";
    const lines = own.map((n) => `${indent}${projectLines.get(n)!.line.trimStart()}`);
    for (const n of own) kept.push(`tokens.css: --${n}: ${projectLines.get(n)!.value} (the project's own token)`);
    if (close >= 0) out.splice(close, 0, ...lines);
    else out.push(...lines);
  }
  return out.join("\n");
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
  const result: KitUpgradeResult = { ok: false, dryRun: !!opts.dryRun, kitDir: kit, from, replaced: [], kept: [], notes: [], backup: null, pruned: [], errors: [] };
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
      write(projectTokens, mergeTokens(ct, pt, result.kept, result.notes));
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
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(path.join(staging, r)))) result.replaced.push(r);
    }
    for (const r of projectFiles) {
      if (inFonts(r, projectFonts) || r === projectTokens || r === "kit.config.json") continue;
      if (!fs.existsSync(path.join(from, r)) && !(r === projectStyles)) result.kept.push(`${r} (not in the clone's kit)`);
    }
    result.ok = true;
    if (opts.dryRun || result.replaced.length === 0) return result;

    // back up what changes, write it, keep the newest backups
    const backup = path.join(kit, BACKUP_DIR, stamp(opts.now ?? new Date()));
    for (const r of result.replaced) {
      if (!fs.existsSync(path.join(kit, r))) continue;
      fs.mkdirSync(path.dirname(path.join(backup, r)), { recursive: true });
      fs.copyFileSync(path.join(kit, r), path.join(backup, r));
    }
    result.backup = backup;
    for (const r of result.replaced) {
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
