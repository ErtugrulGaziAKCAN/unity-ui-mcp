import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The Unity package whose compiler turns an export into a screen. */
export const PACKAGE_NAME = "com.unity.design-ui";

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * The identity of the design-ui package a Unity project uses, so an import notices that the compiler changed although
 * the export did not: `git:<commit>` for a git package (its locked commit), `registry:<version>` for a registry package,
 * and `sha256:<hash>` of the files of a local (`file:`) or embedded package (see {@link contentStamp}). Null when the
 * project has no such package or it cannot be read.
 */
export function packageStamp(projectDir: string): string | null {
  const packages = path.join(projectDir, "Packages");
  const embedded = path.join(packages, PACKAGE_NAME);
  if (fs.existsSync(path.join(embedded, "package.json"))) return contentStamp(embedded);
  const lock = readJson(path.join(packages, "packages-lock.json"))?.dependencies?.[PACKAGE_NAME];
  const declared = readJson(path.join(packages, "manifest.json"))?.dependencies?.[PACKAGE_NAME];
  if (lock?.source === "git" && typeof lock.hash === "string" && lock.hash) return `git:${lock.hash}`;
  const version = typeof lock?.version === "string" ? lock.version : typeof declared === "string" ? declared : null;
  if (version?.startsWith("file:")) {
    const dir = path.resolve(packages, version.slice("file:".length));
    return fs.existsSync(path.join(dir, "package.json")) ? contentStamp(dir) : null;
  }
  if (lock?.source === "registry" && typeof lock.version === "string") return `registry:${lock.version}`;
  return null;
}

/**
 * `sha256:` + the SHA-256 of the package's files: per file, sorted by its path relative to the package folder (with
 * `/`, ordinal), the line `<path>\n<sha256 of its bytes>\n`. Left out: names starting with `.`, folders Unity ignores
 * (ending with `~`) and the top-level `Tests` folder. The Unity package computes the same stamp
 * (`DesignUi.Editor.PackageStamp`; contract: contracts/package-stamp.json).
 */
export function contentStamp(dir: string): string {
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".") || d.name.endsWith("~")) continue;
      if (!rel && d.isDirectory() && d.name === "Tests") continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), r);
      else if (d.isFile()) files.push(r);
    }
  };
  walk(dir, "");
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = crypto.createHash("sha256");
  for (const f of files) hash.update(`${f}\n${sha256(fs.readFileSync(path.join(dir, f)))}\n`);
  return `sha256:${hash.digest("hex")}`;
}
