import fs from "node:fs";
import path from "node:path";

/**
 * Whether a kit folder is a unity-ui-mcp clone's own `design-kit` (tracked in that repository): kit sync must not write
 * the project's fonts and tokens there (a later `git pull` fails, and a project's fonts end up in a public checkout).
 */
export function isCloneKit(kitDir: string): boolean {
  const repo = path.dirname(path.resolve(kitDir));
  return path.basename(path.resolve(kitDir)) === "design-kit" &&
    fs.existsSync(path.join(repo, "packages", "com.ertugrulgaziakcan.design-ui", "package.json")) &&
    fs.existsSync(path.join(repo, "tools", "design-ui-mcp", "package.json"));
}

/** The message for a kitDir that is a clone's design-kit: where to copy it and what to set. */
export function cloneKitMessage(kitDir: string, designRoot: string, configPath: string): string {
  const to = path.join(designRoot, "design-kit");
  return `kitDir is the unity-ui-mcp clone's own design-kit (${kitDir}); kit sync would write the project's fonts into the clone. ` +
    `Copy it into the project (cp -R "${kitDir}" "${to}", then remove "${path.join(to, "fixtures")}") and set "kitDir" to "${to}" in ${configPath}; ` +
    "scripts/setup.sh does this for a new project";
}
