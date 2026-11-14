import { IR_VERSION } from "./exporter.js";
import { PACKAGE_NAME } from "./package-stamp.js";
import { VERSION } from "./version.js";

/** How the Unity package the Editor runs relates to this server: what an import may rely on. */
export interface Drift {
  level: "ok" | "warning" | "error";
  /** Why, for the tool's answer; null when the versions match or the bridge does not report them. */
  message: string | null;
}

const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;

/**
 * The drift between the Unity package (its version and the IR version it reads, as its bridge reports them) and this
 * server (its version and the IR version its exporter writes): another major version or another IR version is an error
 * (an import would compile with a package that does not read this export, or reads it differently), another minor
 * version a warning; a patch difference, or a bridge too old to report them, is fine.
 */
export function versionDrift(packageVersion: string | undefined, irVersion: number | undefined, server: string = VERSION, ir: number = IR_VERSION): Drift {
  if (irVersion !== undefined && irVersion !== ir) {
    return { level: "error", message: `the Unity package ${PACKAGE_NAME} reads IR version ${irVersion}, the exporter writes IR version ${ir}: update ${irVersion < ir ? "the package (scripts/setup.sh of the unity-ui-mcp clone, then let Unity resolve it)" : "the unity-ui-mcp clone (git pull, then scripts/setup.sh)"} so both are one version` };
  }
  const p = packageVersion ? parse(packageVersion) : null, s = parse(server);
  if (!p || !s) return { level: "ok", message: null };
  const what = `the Unity package ${PACKAGE_NAME} is ${packageVersion}, this MCP server ${server}`;
  const fix = "update the older one (git pull and scripts/setup.sh in the unity-ui-mcp clone; Unity resolves the package from packages-lock.json)";
  if (p[0] !== s[0]) return { level: "error", message: `${what} (another major version): ${fix}` };
  if (p[1] !== s[1]) return { level: "warning", message: `${what} (another minor version); ${fix}` };
  return { level: "ok", message: null };
}
