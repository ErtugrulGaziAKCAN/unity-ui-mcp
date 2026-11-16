import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, type TestContext } from "vitest";
import { tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
const SETUP = path.join(REPO, "scripts", "setup.sh");
const SERVER_JS = path.join(REPO, "tools", "design-ui-mcp", "dist", "server.js");
const which = (cmd: string) => execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
const REAL_GIT = which("git");
const NODE = which("node");
/** PATH with node, git and the basic tools, but no `claude`. */
/**
 * Setup pins the package to this clone's tag or commit, which needs a git checkout; a release extract (a tarball, `git
 * archive`) has none, so the tests that run setup's git route without a stubbed HEAD are skipped there, saying why.
 */
const CHECKOUT = spawnSync(REAL_GIT, ["-C", REPO, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" }).status === 0;
const itGit = (name: string, fn: (ctx: TestContext) => unknown, timeout?: number) =>
  it(name, (ctx) => {
    if (!CHECKOUT) ctx.skip("not a git checkout (a release extract): setup pins the package to the clone's commit, which needs git");
    return fn(ctx);
  }, timeout);
const BASE_PATH = [path.dirname(NODE), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const MANIFEST = `{
  "dependencies": {
    "com.unity.test-framework": "1.6.0",
    "com.unity.modules.ui": "1.0.0"
  }
}
`;

/**
 * The answers of the clone's git (setupEnv): its origin, the tag HEAD is at ("" for none), HEAD's commit and the uncommitted
 * changes `git status --porcelain` lists under packages/ and tools/ (none unless given).
 */
interface GitStub { origin?: string; tag?: string; head?: string; dirty?: string }

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
function setupEnv(opts: { projectName?: string; claudeOnPath?: boolean; extraEnv?: Record<string, string>; git?: GitStub } = {}): Env {
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
  // what this clone's git answers about itself: its own origin (a test never depends on the checkout's remote), the tag at
  // HEAD (none unless given) and HEAD's commit (the real one unless given); everything else goes to the real git
  const g = { origin: "https://github.com/example/unity-ui-mcp.git", tag: "", ...opts.git };
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
echo "$*" >> "${logs}/git.log"
case "$*" in
  *" remote get-url origin") echo '${g.origin}'; exit 0 ;;
  *" describe --tags --exact-match HEAD") [ -n '${g.tag}' ] && { echo '${g.tag}'; exit 0; }; echo "fatal: no tag exactly matches" >&2; exit 128 ;;
  *" rev-parse HEAD") [ -n '${g.head ?? ""}' ] && { echo '${g.head ?? ""}'; exit 0; } ;;
  *" status --porcelain --untracked-files=no -- packages tools") printf '%s' '${g.dirty ?? ""}'; exit 0 ;;
esac
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
  itGit("--dry-run lists the changes and changes nothing", () => {
    const e = setupEnv();
    const r = e.run("--dry-run");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("would add \"com.ertugrulgaziakcan.design-ui\"");
    expect(r.out).toContain("would write");
    expect(r.out).toContain("would register MCP server design-ui");
    expect(r.out).toContain(`claude CLI: ${e.claudeStub}`);
    expect(r.out).toContain(`would copy the design kit ${path.join(REPO, "design-kit")} into ${path.join(e.project, "Designs", "design-kit")}`);
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(MANIFEST);
    expect(fs.existsSync(path.join(e.project, "design-ui.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(e.project, "Designs"))).toBe(false);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toEqual([]);
  });

  itGit("adds one manifest line, writes the config, registers once, and a second run changes nothing", () => {
    const e = setupEnv();
    const first = e.run();
    expect(first.code, first.out).toBe(0);
    const manifest = read(path.join(e.project, "Packages", "manifest.json"));
    const added = manifest.split("\n").filter((l) => l.includes("com.ertugrulgaziakcan.design-ui"));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^ {4}"com\.ertugrulgaziakcan\.design-ui": "https:\/\/github\.com\/.+\.git\?path=\/packages\/com\.ertugrulgaziakcan\.design-ui#.+",$/);
    expect(manifest.replace(added[0] + "\n", "")).toBe(MANIFEST);
    const cfg = JSON.parse(read(path.join(e.project, "design-ui.config.json")));
    // the kit is the project's own copy (kit sync writes fonts into it, never into this clone); verification captures on
    // a temporary copy of the project (scripts/capture-on-copy.sh)
    expect(cfg).toMatchObject({
      designRoot: "Designs", kitDir: "Designs/design-kit", mcpServer: SERVER_JS,
      unityRunner: { prefer: "editor", captureVia: "command", command: { capture: [path.join(REPO, "scripts", "capture-on-copy.sh"), "{projectDir}"] } },
    });
    const kit = path.join(e.project, "Designs", "design-kit");
    expect(read(path.join(kit, "kit.config.json"))).toBe(read(path.join(REPO, "design-kit", "kit.config.json")));
    // the clone's configuration the kit was copied from: kit upgrade's base for the lists the project narrows or grows
    expect(read(path.join(kit, ".kit-base.json"))).toBe(read(path.join(REPO, "design-kit", "kit.config.json")));
    expect(fs.existsSync(path.join(kit, "RULES.md"))).toBe(true);
    expect(fs.existsSync(path.join(kit, "fixtures")), "the repository's fidelity fixtures stay in the clone").toBe(false);
    // the project's manifest never lists the package's tests
    expect(JSON.parse(manifest).testables).toBeUndefined();
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

  itGit("passes a path with spaces and quotes intact, and the printed command is valid shell", () => {
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

  itGit("without a claude CLI prints a pasteable command and registers nothing; CLAUDE_BIN selects one explicitly", () => {
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

  itGit("--dry-run for Codex and Cursor prints the planned configuration and writes nothing", () => {
    const e = setupEnv({ projectName: ODD });
    const cursor = e.run("--client", "cursor", "--dry-run");
    expect(cursor.code, cursor.out).toBe(0);
    expect(cursor.out).toContain("would create");
    expect(cursor.out).toContain("MCP server design-ui for project");
    const json = JSON.parse(/^ {4}\{\n[\s\S]*?\n {4}\}$/m.exec(cursor.out)![0]);
    expect(json).toEqual({ mcpServers: { "design-ui": { command: NODE, args: [SERVER_JS, "--project", e.project] } } });
    const codex = e.run("--client", "codex", "--dry-run");
    expect(codex.out).toContain("MCP server design-ui for project");
    expect(codex.out).toContain("[mcp_servers.design-ui]");
    // TOML basic strings and arrays of them read like JSON
    expect(JSON.parse(/^ {4}command = (.+)$/m.exec(codex.out)![1])).toBe(NODE);
    expect(JSON.parse(/^ {4}args = (.+)$/m.exec(codex.out)![1])).toEqual([SERVER_JS, "--project", e.project]);
    expect(lines(path.join(e.logs, "claude.log"))).toEqual([]);
    expect(fs.existsSync(path.join(e.env.HOME!, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(e.env.HOME!, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(e.clientDir, ".cursor"))).toBe(false);
  });

  itGit("an existing config whose kitDir is this clone's design-kit gets a message to move it; kit sync would write into the clone", () => {
    const e = setupEnv();
    fs.writeFileSync(path.join(e.project, "design-ui.config.json"), JSON.stringify({ designRoot: "Designs", kitDir: path.join(REPO, "design-kit"), profileAsset: "Assets/P.asset", mcpServer: SERVER_JS }) + "\n");
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`kitDir is this clone's design-kit (${path.join(REPO, "design-kit")})`);
    expect(r.out).toMatch(/cp -R .*design-kit.* .*Designs\/design-kit/);
    expect(fs.existsSync(path.join(e.project, "Designs", "design-kit")), "setup changes no existing config and copies nothing for it").toBe(false);
  });

  itGit("an existing project kit is kept, with the command that upgrades it to this clone's kit", () => {
    const e = setupEnv();
    const kit = path.join(e.project, "Designs", "design-kit");
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, "kit.config.json"), "{}\n");
    fs.writeFileSync(path.join(e.project, "design-ui.config.json"), JSON.stringify({ designRoot: "Designs", kitDir: "Designs/design-kit", profileAsset: "Assets/P.asset", mcpServer: SERVER_JS }) + "\n");
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`the project's design kit ${kit} is kept as it is`);
    expect(r.out).toMatch(/npx design-export kit upgrade .*Designs\/design-kit --dry-run/);
    expect(read(path.join(kit, "kit.config.json"))).toBe("{}\n");
  });

  itGit("keeps an existing package entry and an existing config", () => {
    const e = setupEnv();
    const manifest = MANIFEST.replace(`"dependencies": {`, `"dependencies": {\n    "com.ertugrulgaziakcan.design-ui": "file:/somewhere/else",`);
    fs.writeFileSync(path.join(e.project, "Packages", "manifest.json"), manifest);
    fs.writeFileSync(path.join(e.project, "design-ui.config.json"), "{\"mine\": true}\n");
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("kept existing entry");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(manifest);
    expect(read(path.join(e.project, "design-ui.config.json"))).toBe("{\"mine\": true}\n");
    expect(r.out).toContain(`has no "mcpServer" (the Design UI window's client snippets need it): add "mcpServer": ${JSON.stringify(SERVER_JS)}`);
    expect(r.out).toContain("Nothing to change");
  });

  const OLD = "com.unity.design-ui", NEW = "com.ertugrulgaziakcan.design-ui";

  it("replaces the package id before 0.1.0 in place and removes its testables entry; --dry-run shows the same plan first", () => {
    const e = setupEnv();
    const file = path.join(e.project, "Packages", "manifest.json");
    const oldUrl = `https://github.com/x/unity-ui-mcp.git?path=/packages/${OLD}#m0-m1`;
    const before = `{
  "testables": ["com.unity.test-framework", "${OLD}"],
  "dependencies": {
    "com.unity.test-framework": "1.6.0",
    "${OLD}": "${oldUrl}",
    "com.unity.modules.ui": "1.0.0"
  }
}
`;
    fs.writeFileSync(file, before);
    const value = `file:${path.join(REPO, "packages", NEW)}`;
    const dry = e.run("--dry-run", "--package", "local", "--client", "none");
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(`would replace the old package id "${OLD}": "${oldUrl}" with "${NEW}": ${JSON.stringify(value)} in Packages/manifest.json`);
    // the user's manifest never lists the package's tests: captures list them in their temporary copy only
    const removal = `remove "${OLD}" from the "testables" of Packages/manifest.json (the package tests are listed only in the temporary copy a capture makes)`;
    expect(dry.out).toContain(`would ${removal}`);
    expect(dry.out).not.toContain(`with "${NEW}" in the "testables"`);
    expect(dry.out).not.toContain("would add");
    expect(read(file)).toBe(before);

    const r = e.run("--package", "local", "--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`change: ${removal}`);
    // the same plan as the dry run, change for change
    const planned = (out: string, prefix: string) => out.split("\n").filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
    expect(planned(r.out, "  change: ")).toEqual(planned(dry.out, "  would "));
    expect(read(file)).toBe(before.replace(`"${OLD}": "${oldUrl}"`, `"${NEW}": ${JSON.stringify(value)}`).replace(`, "${OLD}"]`, `]`));
    expect(JSON.parse(read(file)).testables).toEqual(["com.unity.test-framework"]);
    const again = e.run("--package", "local", "--client", "none");
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain(`kept existing entry "${NEW}"`);
    expect(again.out).toContain("Nothing to change");
  });

  it("removes the old package id's only testables entry and leaves the user's other manifest keys alone", () => {
    const e = setupEnv();
    const file = path.join(e.project, "Packages", "manifest.json");
    fs.writeFileSync(file, `{
  "dependencies": {
    "${OLD}": "file:/old"
  },
  "testables": [ "${OLD}" ]
}
`);
    const r = e.run("--package", "local", "--client", "none");
    expect(r.code, r.out).toBe(0);
    const json = JSON.parse(read(file));
    expect(json.testables).toEqual([]);
    expect(Object.keys(json.dependencies)).toEqual([NEW]);
  });

  itGit("removes the old package id when the new one is listed too, and warns about an embedded copy under the old id", () => {
    const e = setupEnv();
    const file = path.join(e.project, "Packages", "manifest.json");
    fs.writeFileSync(file, `{
  "testables": ["${NEW}", "${OLD}"],
  "dependencies": {
    "${NEW}": "file:/mine",
    "${OLD}": "file:/old"
  }
}
`);
    fs.mkdirSync(path.join(e.project, "Packages", OLD));
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`remove the old package id "${OLD}": "file:/old" from Packages/manifest.json (it lists "${NEW}" too)`);
    expect(r.out).toContain(`remove "${OLD}" from the "testables" of Packages/manifest.json (the package tests are listed only in the temporary copy a capture makes)`);
    expect(r.out).toContain(`kept existing entry "${NEW}": "file:/mine"`);
    expect(r.out).toContain(`warning: Packages/${OLD} is an embedded copy`);
    // the new id stays in "testables" (the user's entry), with a note
    expect(r.out).toContain(`note: Packages/manifest.json lists "${NEW}" in "testables": the package tests then run in this project`);
    expect(read(file)).toBe(`{
  "testables": ["${NEW}"],
  "dependencies": {
    "${NEW}": "file:/mine"
  }
}
`);
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
    expect(json.dependencies["com.ertugrulgaziakcan.design-ui"]).toBe(`file:${path.join(REPO, "packages", "com.ertugrulgaziakcan.design-ui")}`);
    expect(json.scopedRegistries[0].dependencies).toEqual({});
    expect(out.split("\n").length).toBe(nested.split("\n").length + 1);
  });

  it("pins the package to the tag HEAD is at, else to HEAD's full commit, never to a branch name", () => {
    const pkg = (e: Env) => JSON.parse(read(path.join(e.project, "Packages", "manifest.json"))).dependencies["com.ertugrulgaziakcan.design-ui"];
    const url = "https://github.com/example/unity-ui-mcp.git?path=/packages/com.ertugrulgaziakcan.design-ui";
    const tagged = setupEnv({ git: { tag: "v0.1.0" } });
    expect(tagged.run("--client", "none").code).toBe(0);
    expect(pkg(tagged)).toBe(`${url}#v0.1.0`);
    const head = "0123456789abcdef0123456789abcdef01234567";
    const commit = setupEnv({ git: { head } });
    const r = commit.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(pkg(commit)).toBe(`${url}#${head}`);
    // an ssh origin is written as its https URL
    const ssh = setupEnv({ git: { origin: "git@github.com:example/unity-ui-mcp", head } });
    expect(ssh.run("--client", "none").code).toBe(0);
    expect(pkg(ssh)).toBe(`${url}#${head}`);
  });

  it("warns when it pins HEAD while the package's or the server's sources have uncommitted changes", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const warning = /warning: this clone has 2 uncommitted changes under packages\/ or tools\/: Unity resolves commit 0123456789abcdef0123456789abcdef01234567 as committed, while the server is built from the working tree; commit them, or run setup with --package local/;
    const dirty = setupEnv({ git: { head, dirty: " M packages/com.ertugrulgaziakcan.design-ui/Editor/Ir/IrReader.cs\n M tools/design-export/src/export.ts\n" } });
    const r = dirty.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(warning);
    const clean = setupEnv({ git: { head } }).run("--client", "none");
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).not.toMatch(/uncommitted changes/);
    // the clone itself is referenced (--package local): nothing is pinned, nothing to warn about
    const local = setupEnv({ git: { head, dirty: " M tools/design-export/src/export.ts\n" } }).run("--package", "local", "--client", "none");
    expect(local.out).not.toMatch(/uncommitted changes/);
  });

  it("references this clone when its origin is a local path (Unity cannot resolve one as a git URL), and says so", () => {
    for (const origin of ["/somewhere/unity-ui-mcp", "../unity-ui-mcp", "file:///somewhere/unity-ui-mcp"]) {
      const e = setupEnv({ git: { origin } });
      const r = e.run("--client", "none");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`origin is a local path (${origin})`);
      expect(read(path.join(e.project, "Packages", "manifest.json"))).toContain(`"com.ertugrulgaziakcan.design-ui": "file:${path.join(REPO, "packages", "com.ertugrulgaziakcan.design-ui")}",`);
    }
  });

  it("--package local references this clone and --design-root sets designRoot", () => {
    const e = setupEnv();
    const r = e.run("--package", "local", "--client", "none", "--design-root", "UI/Designs");
    expect(r.code, r.out).toBe(0);
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toContain(`"com.ertugrulgaziakcan.design-ui": "file:${path.join(REPO, "packages", "com.ertugrulgaziakcan.design-ui")}",`);
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

describe("setup.sh multi-client registration and skill install", () => {
  const codexConfig = (e: Env) => path.join(e.env.HOME!, ".codex", "config.toml");
  const OTHER_TOML = `# my codex config\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["a"]\n\n[profiles.p]\nk = 1\n`;

  itGit("Codex: adds exactly one table once, keeps the rest byte for byte, second run changes nothing", () => {
    const e = setupEnv({ projectName: ODD });
    fs.mkdirSync(path.join(e.env.HOME!, ".codex"));
    fs.writeFileSync(codexConfig(e), OTHER_TOML);
    const first = e.run("--client", "codex");
    expect(first.code, first.out).toBe(0);
    const after = read(codexConfig(e));
    expect(after.startsWith(OTHER_TOML)).toBe(true);
    expect(after.match(/^\[mcp_servers\.design-ui\]$/gm)).toHaveLength(1);
    const table = after.slice(OTHER_TOML.length);
    expect(JSON.parse(/^command = (.+)$/m.exec(table)![1])).toBe(NODE);
    expect(JSON.parse(/^args = (.+)$/m.exec(table)![1])).toEqual([SERVER_JS, "--project", e.project]);
    const second = e.run("--client", "codex");
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("Nothing to change");
    expect(read(codexConfig(e))).toBe(after);
  });

  itGit("Codex: another project's design-ui entry stays; this project gets design-ui-<folder>, created when the file is absent", () => {
    const e = setupEnv({ projectName: "My Game" });
    fs.mkdirSync(path.join(e.env.HOME!, ".codex"));
    const old = `[mcp_servers.design-ui]\ncommand = "old"\nargs = ["x", "--project", "/other"]\n\n`;
    const rest = `[profiles.p]\nk = 1\n`;
    fs.writeFileSync(codexConfig(e), `a = 1\n\n${old}${rest}`);
    const r = e.run("--client", "codex");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("MCP server design-ui-my-game for project");
    const out = read(codexConfig(e));
    expect(out.startsWith(`a = 1\n\n${old}${rest}`)).toBe(true);
    expect(out).toContain("[mcp_servers.design-ui-my-game]");
    expect(read(codexConfig(e) + ".design-ui.bak")).toBe(`a = 1\n\n${old}${rest}`);

    const f = setupEnv();
    const created = f.run("--client", "codex");
    expect(created.code, created.out).toBe(0);
    expect(read(codexConfig(f)).match(/^\[mcp_servers\.design-ui\]$/gm)).toHaveLength(1);
  });

  itGit("Cursor: merges into an existing mcp.json keeping other servers; --client-dir selects the folder; second run no change", () => {
    const e = setupEnv();
    const file = path.join(e.clientDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: "k" } }, extra: 1 }, null, 2) + "\n");
    const first = e.run("--client", "cursor");
    expect(first.code, first.out).toBe(0);
    const json = JSON.parse(read(file));
    expect(json).toEqual({
      mcpServers: { keep: { command: "k" }, "design-ui": { command: NODE, args: [SERVER_JS, "--project", e.project] } },
      extra: 1,
    });
    const bytes = read(file);
    const second = e.run("--client", "cursor");
    expect(second.out).toContain("Nothing to change");
    expect(read(file)).toBe(bytes);
  });

  itGit("Cursor without --client-dir uses ~/.cursor/mcp.json", () => {
    const e = setupEnv();
    const r = spawnSync("bash", [SETUP, "--project", e.project, "--no-build", "--client", "cursor"], { env: e.env, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const json = JSON.parse(read(path.join(e.env.HOME!, ".cursor", "mcp.json")));
    expect(json.mcpServers["design-ui"].args).toEqual([SERVER_JS, "--project", e.project]);
  });

  itGit("--client all skips clients whose config folder is missing and says so", () => {
    const e = setupEnv();
    const r = e.run("--client", "all");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("skipped codex");
    expect(r.out).toContain("skipped cursor");
    expect(fs.existsSync(path.join(e.env.HOME!, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(e.clientDir, ".cursor"))).toBe(false);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toHaveLength(1);
  });

  itGit("--client all registers Claude Code, Codex and Cursor when their folders exist", () => {
    const e = setupEnv();
    fs.mkdirSync(path.join(e.env.HOME!, ".codex"));
    fs.mkdirSync(path.join(e.clientDir, ".cursor"));
    const r = e.run("--client", "all");
    expect(r.code, r.out).toBe(0);
    expect(lines(path.join(e.logs, "claude.log")).filter((l) => l.includes("mcp add"))).toHaveLength(1);
    expect(read(codexConfig(e))).toContain("[mcp_servers.design-ui]");
    expect(fs.existsSync(path.join(e.clientDir, ".cursor", "mcp.json"))).toBe(true);
  });

  it("a broken Codex config stops setup before any change to the project", () => {
    const e = setupEnv();
    fs.mkdirSync(path.join(e.env.HOME!, ".codex"));
    fs.writeFileSync(codexConfig(e), "this is = = not toml\n");
    const r = e.run("--client", "codex");
    expect(r.code).toBe(2);
    expect(r.out).toContain("not valid TOML");
    expect(r.out).toContain("no Unity project file and no client config was changed");
    expect(read(path.join(e.project, "Packages", "manifest.json"))).toBe(MANIFEST);
    expect(fs.existsSync(path.join(e.project, "design-ui.config.json"))).toBe(false);
    expect(read(codexConfig(e))).toBe("this is = = not toml\n");
  });

  itGit("links the skill into the existing skill folders only, once; second run changes nothing; dry-run changes nothing", () => {
    const e = setupEnv();
    const home = e.env.HOME!;
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
    const dry = e.run("--client", "none", "--dry-run");
    expect(dry.out).toContain("would link");
    expect(fs.readdirSync(path.join(home, ".claude", "skills"))).toEqual([]);
    const r = e.run("--client", "none");
    expect(r.code, r.out).toBe(0);
    const want = path.join(REPO, "skills", "unity-ui-mcp");
    expect(fs.readlinkSync(path.join(home, ".claude", "skills", "unity-ui-mcp"))).toBe(want);
    expect(fs.readlinkSync(path.join(home, ".codex", "skills", "unity-ui-mcp"))).toBe(want);
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
    const again = e.run("--client", "none");
    expect(again.out).toContain("Nothing to change");
  });
});

describe("scripts/install-skill.sh", () => {
  const INSTALL = path.join(REPO, "scripts", "install-skill.sh");
  const SKILL_DIR = path.join(REPO, "skills", "unity-ui-mcp");
  const run = (home: string, ...args: string[]) => {
    const r = spawnSync("bash", [INSTALL, ...args], { env: { PATH: BASE_PATH, HOME: home }, encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout + r.stderr };
  };

  it("creates links once, reports already in place, replaces only its own stale link, never touches other skills", () => {
    const home = tempDir("design-ui-home-");
    const claude = path.join(home, ".claude", "skills");
    const cursor = path.join(home, ".cursor", "skills");
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(cursor, { recursive: true });
    fs.mkdirSync(path.join(claude, "other-skill"));
    fs.writeFileSync(path.join(claude, "other-skill", "SKILL.md"), "mine");
    fs.symlinkSync("/nonexistent/elsewhere", path.join(cursor, "unity-ui-mcp")); // stale link of this name

    const first = run(home);
    expect(first.code, first.out).toBe(0);
    expect(fs.readlinkSync(path.join(claude, "unity-ui-mcp"))).toBe(SKILL_DIR);
    expect(fs.readlinkSync(path.join(cursor, "unity-ui-mcp"))).toBe(SKILL_DIR);
    expect(read(path.join(claude, "other-skill", "SKILL.md"))).toBe("mine");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);

    const second = run(home);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(/already in place/);
    expect(second.out).not.toMatch(/change:|would/);
  });

  it("leaves a real folder or file with that name alone and says so", () => {
    const home = tempDir("design-ui-home-");
    const dir = path.join(home, ".codex", "skills");
    fs.mkdirSync(path.join(dir, "unity-ui-mcp"), { recursive: true });
    fs.writeFileSync(path.join(dir, "unity-ui-mcp", "SKILL.md"), "user copy");
    const r = run(home);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/not a link|left alone/i);
    expect(fs.lstatSync(path.join(dir, "unity-ui-mcp")).isSymbolicLink()).toBe(false);
    expect(read(path.join(dir, "unity-ui-mcp", "SKILL.md"))).toBe("user copy");
  });

  it("creates Claude Code's skill folder when Claude Code is installed without one", () => {
    const home = tempDir("design-ui-home-");
    fs.mkdirSync(path.join(home, ".claude"));
    const dry = run(home, "--dry-run");
    expect(dry.out).toMatch(/would create .*\.claude\/skills/);
    // the dry run shows the link it will make in the folder it would create
    expect(dry.out).toContain(`would link ${path.join(home, ".claude", "skills", "unity-ui-mcp")} -> ${SKILL_DIR}`);
    expect(dry.out).not.toContain(`skipped: ${path.join(home, ".claude", "skills")}`);
    expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);
    const r = run(home);
    expect(r.code, r.out).toBe(0);
    expect(fs.readlinkSync(path.join(home, ".claude", "skills", "unity-ui-mcp"))).toBe(SKILL_DIR);
  });

  it("--dry-run prints the links and creates nothing; with no skill folder it says so", () => {
    const home = tempDir("design-ui-home-");
    const none = run(home);
    expect(none.out).toMatch(/no skill folder/i);
    fs.mkdirSync(path.join(home, ".cursor", "skills"), { recursive: true });
    const dry = run(home, "--dry-run");
    expect(dry.out).toContain("would link");
    expect(dry.out).toContain("skipped:");
    expect(fs.readdirSync(path.join(home, ".cursor", "skills"))).toEqual([]);
  });
});

