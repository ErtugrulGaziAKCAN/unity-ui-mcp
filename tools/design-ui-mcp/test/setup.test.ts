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
const which = (cmd: string) => execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
const REAL_GIT = which("git");
const NODE = which("node");
/** PATH with node, git and the basic tools, but no `claude`. */
const BASE_PATH = [path.dirname(NODE), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const MANIFEST = `{
  "dependencies": {
    "com.unity.test-framework": "1.6.0",
    "com.unity.modules.ui": "1.0.0"
  }
}
`;

interface Env {
  project: string;
  clientDir: string;
  logs: string;
  claudeStub: string;
  env: NodeJS.ProcessEnv;
  run(...args: string[]): { code: number; out: string };
}

/**
 * A temp Unity project, a client folder, and stub `claude` and `git` that record their calls (`claude` on PATH unless
 * `claudeOnPath` is false; its last argv is written one argument per line).
 */
function setupEnv(opts: { projectName?: string; claudeOnPath?: boolean; extraEnv?: Record<string, string> } = {}): Env {
  const root = tempDir("design-ui-setup-");
  const project = path.join(root, opts.projectName ?? "Game");
  fs.mkdirSync(path.join(project, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(project, "Packages"));
  fs.writeFileSync(path.join(project, "Packages", "manifest.json"), MANIFEST);
  const clientDir = path.join(root, "client dir");
  fs.mkdirSync(clientDir);
  const bin = path.join(root, "bin");
  const claudeBin = path.join(root, "claude-bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(claudeBin);
  const logs = path.join(root, "logs");
  fs.mkdirSync(logs);
  const claudeStub = path.join(claudeBin, "claude");
  fs.writeFileSync(claudeStub, `#!/bin/sh
echo "$(pwd) :: $*" >> "${logs}/claude.log"
printf '%s\\n' "$@" > "${logs}/claude-last-args"
state="${logs}/claude-state"
if [ "$1 $2" = "mcp get" ]; then
  if [ -f "$state" ]; then cat "$state"; exit 0; fi
  echo "No MCP server named $3."; exit 1
fi
if [ "$1 $2" = "mcp add" ]; then printf 'design-ui:\\n  Args: %s\\n  Status: connected\\n' "$*" > "$state"; cp "${logs}/claude-last-args" "${logs}/claude-add-args"; exit 0; fi
if [ "$1 $2" = "mcp remove" ]; then rm -f "$state"; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
echo "$*" >> "${logs}/git.log"
exec "${REAL_GIT}" "$@"
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: [bin, ...(opts.claudeOnPath === false ? [] : [claudeBin]), BASE_PATH].join(":"),
    HOME: path.join(root, "home"), DESIGN_UI_SETUP_OFFLINE: "1", ...opts.extraEnv,
  };
  fs.mkdirSync(env.HOME!);
  return {
    project, clientDir, logs, claudeStub, env,
    run(...args) {
      const r = spawnSync("bash", [SETUP, "--project", project, "--client-dir", clientDir, "--no-build", ...args], { env, encoding: "utf8" });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
  };
}

const read = (f: string) => fs.readFileSync(f, "utf8");
const lines = (f: string) => (fs.existsSync(f) ? read(f).split("\n").filter(Boolean) : []);
const expectedAddArgs = (project: string) => ["mcp", "add", "--scope", "local", "design-ui", "--", NODE, SERVER_JS, "--project", project];
const ODD = `my "odd" game's dir`;

describe("scripts/setup.sh", () => {
  it("--dry-run lists the changes and changes nothing", () => {
    const e = setupEnv();
    const r = e.run("--dry-run");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("would add \"com.unity.design-ui\"");
    expect(r.out).toContain("would write");
    expect(r.out).toContain("would register MCP server design-ui");
    expect(r.out).toContain(`claude CLI: ${e.claudeStub}`);
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
    expect(adds[0].startsWith(`${e.clientDir} :: `)).toBe(true);
    expect(lines(path.join(e.logs, "claude-add-args"))).toEqual(expectedAddArgs(e.project));

    const configBytes = read(path.join(e.project, "design-ui.config.json"));
    const second = e.run();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("Nothing to change");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(manifest);
    expect(read(path.join(e.project, "design-ui.config.json"))).toBe(configBytes);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toHaveLength(1);
    expect(lines(path.join(e.logs, "git.log")).filter((l) => /^(commit|push|add|stash|reset)\b/.test(l))).toEqual([]);
  });

  it("passes a path with spaces and quotes intact, and the printed command is valid shell", () => {
    const e = setupEnv({ projectName: ODD });
    const r = e.run();
    expect(r.code, r.out).toBe(0);
    expect(lines(path.join(e.logs, "claude-add-args"))).toEqual(expectedAddArgs(e.project));
    // the printed command (shell-quoted) runs the same registration when pasted into a shell
    const printed = /register MCP server design-ui for Claude Code in .*?: (.+)$/m.exec(r.out)?.[1];
    expect(printed, r.out).toBeTruthy();
    fs.rmSync(path.join(e.logs, "claude-add-args"));
    const again = spawnSync("bash", ["-c", printed!], { env: e.env, encoding: "utf8" });
    expect(again.status, again.stderr).toBe(0);
    expect(lines(path.join(e.logs, "claude-add-args"))).toEqual(expectedAddArgs(e.project));
  });

  it("without a claude CLI prints a pasteable command and registers nothing; CLAUDE_BIN selects one explicitly", () => {
    const e = setupEnv({ projectName: ODD, claudeOnPath: false });
    const r = e.run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("claude CLI: not found");
    expect(lines(path.join(e.logs, "claude.log"))).toEqual([]);
    const printed = /^ {4}(cd .+ && claude mcp add .+)$/m.exec(r.out)?.[1];
    expect(printed, r.out).toBeTruthy();
    const pasted = spawnSync("bash", ["-c", printed!], { env: { ...e.env, PATH: `${path.dirname(e.claudeStub)}:${e.env.PATH}` }, encoding: "utf8" });
    expect(pasted.status, pasted.stderr).toBe(0);
    expect(lines(path.join(e.logs, "claude-add-args"))).toEqual(expectedAddArgs(e.project));
    expect(lines(path.join(e.logs, "claude.log"))[0].startsWith(`${e.clientDir} :: `)).toBe(true);

    const x = setupEnv({ claudeOnPath: false, extraEnv: { CLAUDE_BIN: "" } });
    const explicit = spawnSync("bash", [SETUP, "--project", x.project, "--client-dir", x.clientDir, "--no-build"], {
      env: { ...x.env, CLAUDE_BIN: x.claudeStub }, encoding: "utf8",
    });
    expect(explicit.status, explicit.stdout + explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain(`claude CLI: ${x.claudeStub}`);
    expect(lines(path.join(x.logs, "claude-add-args"))).toEqual(expectedAddArgs(x.project));
  });

  it("prints Cursor and Codex snippets that parse back to the exact paths", () => {
    const e = setupEnv({ projectName: ODD });
    const cursor = e.run("--client", "cursor", "--dry-run");
    expect(cursor.code, cursor.out).toBe(0);
    const json = JSON.parse(/^\{\n[\s\S]*?\n\}$/m.exec(cursor.out)![0]);
    expect(json).toEqual({ mcpServers: { "design-ui": { command: NODE, args: [SERVER_JS, "--project", e.project] } } });
    const codex = e.run("--client", "codex", "--dry-run");
    expect(codex.out).toContain("[mcp_servers.design-ui]");
    // TOML basic strings and arrays of them read like JSON
    expect(JSON.parse(/^command = (.+)$/m.exec(codex.out)![1])).toBe(NODE);
    expect(JSON.parse(/^args = (.+)$/m.exec(codex.out)![1])).toEqual([SERVER_JS, "--project", e.project]);
    expect(lines(path.join(e.logs, "claude.log"))).toEqual([]);
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

  it("edits the top-level dependencies only, and keeps a UTF-8 BOM", () => {
    const e = setupEnv();
    const nested = `﻿{
  "scopedRegistries": [ { "name": "x", "url": "https://example.invalid", "dependencies": {} } ],
  "dependencies": {
    "com.unity.modules.ui": "1.0.0"
  }
}
`;
    const file = path.join(e.project, "Packages", "manifest.json");
    fs.writeFileSync(file, nested);
    const r = e.run("--package", "local", "--client", "none");
    expect(r.code, r.out).toBe(0);
    const out = read(file);
    expect(out.startsWith("﻿")).toBe(true);
    const json = JSON.parse(out.slice(1));
    expect(json.dependencies["com.unity.design-ui"]).toBe(`file:${path.join(REPO, "packages", "com.unity.design-ui")}`);
    expect(json.scopedRegistries[0].dependencies).toEqual({});
    expect(out.split("\n").length).toBe(nested.split("\n").length + 1);
  });

  it("--package local references this clone and --design-root sets designRoot", () => {
    const e = setupEnv();
    const r = e.run("--package", "local", "--client", "none", "--design-root", "UI/Designs");
    expect(r.code, r.out).toBe(0);
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toContain(`"com.unity.design-ui": "file:${path.join(REPO, "packages", "com.unity.design-ui")}",`);
    expect(JSON.parse(read(path.join(e.project, "design-ui.config.json"))).designRoot).toBe("UI/Designs");
  });

  it("refuses a folder that is not a Unity project, and an option without its value", () => {
    const r = spawnSync("bash", [SETUP, "--project", tempDir(), "--no-build"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a Unity project");
    const e = setupEnv();
    const missing = spawnSync("bash", [SETUP, "--client-dir", e.clientDir, "--project"], { env: e.env, encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("--project needs a value");
  });
});
