import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
const SETUP = path.join(REPO, "scripts", "setup.sh");
const SERVER_JS = path.join(REPO, "tools", "design-ui-mcp", "dist", "server.js");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const MANIFEST = `{
  "dependencies": {
    "com.unity.test-framework": "1.6.0",
    "com.unity.modules.ui": "1.0.0"
  }
}
`;

interface Env { project: string; clientDir: string; logs: string; run(...args: string[]): { code: number; out: string } }

/** A temp Unity project, a client folder, and stub `claude` and `git` on PATH that record their calls. */
function setupEnv(): Env {
  const root = tempDir("design-ui-setup-");
  const project = path.join(root, "Game");
  fs.mkdirSync(path.join(project, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(project, "Packages"));
  fs.writeFileSync(path.join(project, "Packages", "manifest.json"), MANIFEST);
  const clientDir = path.join(root, "client");
  fs.mkdirSync(clientDir);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const logs = path.join(root, "logs");
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
echo "$(pwd) :: $*" >> "${logs}/claude.log"
state="${logs}/claude-state"
if [ "$1 $2" = "mcp get" ]; then
  if [ -f "$state" ]; then cat "$state"; exit 0; fi
  echo "No MCP server named $3."; exit 1
fi
if [ "$1 $2" = "mcp add" ]; then printf 'design-ui:\\n  Args: %s\\n  Status: connected\\n' "$*" > "$state"; exit 0; fi
if [ "$1 $2" = "mcp remove" ]; then rm -f "$state"; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
echo "$*" >> "${logs}/git.log"
exec "${REAL_GIT}" "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(root, "home"), DESIGN_UI_SETUP_OFFLINE: "1",
  } as NodeJS.ProcessEnv;
  delete env.CLAUDE_BIN;
  fs.mkdirSync(env.HOME!);
  return {
    project, clientDir, logs,
    run(...args) {
      const r = spawnSync("bash", [SETUP, "--project", project, "--client-dir", clientDir, "--no-build", ...args], { env, encoding: "utf8" });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
  };
}

const read = (f: string) => fs.readFileSync(f, "utf8");
const lines = (f: string) => (fs.existsSync(f) ? read(f).split("\n").filter(Boolean) : []);

describe("scripts/setup.sh", () => {
  it("--dry-run lists the changes and changes nothing", () => {
    const e = setupEnv();
    const r = e.run("--dry-run");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("would: added \"com.unity.design-ui\"");
    expect(r.out).toContain("would: write");
    expect(r.out).toContain("would: register MCP server design-ui");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(MANIFEST);
    expect(fs.existsSync(path.join(e.project, "design-ui.config.json"))).toBe(false);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toEqual([]);
  });

  it("adds one manifest line, writes the config, registers once, and a second run changes nothing", () => {
    const e = setupEnv();
    const first = e.run();
    expect(first.code, first.out).toBe(0);
    const manifest = read(path.join(e.project, "Packages", "manifest.json"));
    const added = manifest.split("\n").filter((l) => l.includes("com.unity.design-ui"));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^ {4}"com\.unity\.design-ui": "https:\/\/github\.com\/.+\.git\?path=\/packages\/com\.unity\.design-ui#.+",$/);
    expect(manifest.replace(added[0] + "\n", "")).toBe(MANIFEST);
    const cfg = JSON.parse(read(path.join(e.project, "design-ui.config.json")));
    expect(cfg).toMatchObject({ designRoot: "Designs", kitDir: path.join(REPO, "design-kit"), unityRunner: { prefer: "editor" } });
    const adds = lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"));
    expect(adds).toHaveLength(1);
    expect(adds[0]).toContain(`${e.clientDir} :: mcp add --scope local design-ui -- `);
    expect(adds[0]).toContain(`${SERVER_JS} --project ${e.project}`);

    const configBytes = read(path.join(e.project, "design-ui.config.json"));
    const second = e.run();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("Nothing to change");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(manifest);
    expect(read(path.join(e.project, "design-ui.config.json"))).toBe(configBytes);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toHaveLength(1);
    expect(lines(path.join(e.logs, "git.log")).filter((l) => /^(commit|push|add|stash|reset)\b/.test(l))).toEqual([]);
  });

  it("keeps an existing package entry and an existing config", () => {
    const e = setupEnv();
    const manifest = MANIFEST.replace(`"dependencies": {`, `"dependencies": {\n    "com.unity.design-ui": "file:/somewhere/else",`);
    fs.writeFileSync(path.join(e.project, "Packages", "manifest.json"), manifest);
    fs.writeFileSync(path.join(e.project, "design-ui.config.json"), "{\"mine\": true}\n");
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("kept existing entry");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(manifest);
    expect(read(path.join(e.project, "design-ui.config.json"))).toBe("{\"mine\": true}\n");
    expect(r.out).toContain("Nothing to change");
  });

  it("--package local references this clone; other clients get a snippet", () => {
    const e = setupEnv();
    const r = e.run("--package", "local", "--client", "codex", "--design-root", "UI/Designs");
    expect(r.code, r.out).toBe(0);
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toContain(`"com.unity.design-ui": "file:${path.join(REPO, "packages", "com.unity.design-ui")}",`);
    expect(JSON.parse(read(path.join(e.project, "design-ui.config.json"))).designRoot).toBe("UI/Designs");
    expect(r.out).toContain("[mcp_servers.design-ui]");
    expect(r.out).toContain(SERVER_JS);
    expect(lines(path.join(e.logs, "claude.log"))).toEqual([]);
  });

  it("refuses a folder that is not a Unity project", () => {
    const r = spawnSync("bash", [SETUP, "--project", tempDir(), "--no-build"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a Unity project");
  });
});
