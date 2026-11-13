import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CJS = path.resolve(here, "../../../scripts/client-config.cjs");
const PROJECT = "/work/My Game";
const SERVER = "/clone/tools/design-ui-mcp/dist/server.js";

function run(kind: "toml" | "json", content: string | null, dry = false) {
  const dir = tempDir("design-ui-cc-");
  const file = path.join(dir, kind === "toml" ? "config.toml" : "mcp.json");
  if (content !== null) fs.writeFileSync(file, content);
  const r = spawnSync("node", [CJS, kind, file, "/usr/bin/node", SERVER, PROJECT, dry ? "1" : "0"], { encoding: "utf8" });
  const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return { first: r.stdout.split("\n")[0], out: r.stdout, after, file };
}
const ENTRY = { command: "/usr/bin/node", args: [SERVER, "--project", PROJECT] };

describe("client-config.cjs (TOML)", () => {
  it("detects an inline-table design-ui under [mcp_servers] and replaces it as a whole, keeping extra keys", () => {
    const src = `# top comment\n[mcp_servers]\ndesign-ui = { command = "a", args = ["x", "--project", "${PROJECT}"], startup_timeout_sec = 30 }\nother = { command = "o" }\n\n[tools]\nx = 1 # trailing\n`;
    const r = run("toml", src);
    expect(r.first).toBe("CHANGE update design-ui");
    const doc = parse(r.after!) as any;
    expect(doc.mcp_servers["design-ui"]).toEqual({ ...ENTRY, startup_timeout_sec: 30 });
    expect(doc.mcp_servers.other).toEqual({ command: "o" });
    expect(r.after).toContain("# top comment");
    expect(r.after).toContain("x = 1 # trailing");
    expect(r.after!.match(/design-ui/g)!.length).toBeLessThan(4);
  });

  it("detects dotted keys", () => {
    const src = `mcp_servers.design-ui.command = "a"\nmcp_servers.design-ui.args = ["x", "--project", "${PROJECT}"]\nmcp_servers.design-ui.env.K = "v"\nname = "keep"\n`;
    const r = run("toml", src);
    const doc = parse(r.after!) as any;
    expect(doc.mcp_servers["design-ui"]).toEqual({ ...ENTRY, env: { K: "v" } });
    expect(doc.name).toBe("keep");
  });

  it("handles a multi-line array whose lines start with [ inside the table", () => {
    const src = `[mcp_servers.design-ui]\ncommand = "a"\nargs = [\n  "${SERVER}", "--project",\n  "${PROJECT}",\n]\nodd = [\n  ["x"],\n  ["y"],\n]\n\n[profiles.p]\nk = 1\n`;
    const r = run("toml", src);
    const doc = parse(r.after!) as any;
    expect(doc.mcp_servers["design-ui"]).toEqual({ ...ENTRY, odd: [["x"], ["y"]] });
    expect(doc.profiles.p).toEqual({ k: 1 });
    expect(r.after!.match(/^\[mcp_servers\.design-ui\]$/gm)).toHaveLength(1);
  });

  it("keeps env subtables and other keys of this project's entry; update only command and args", () => {
    const src = `[mcp_servers.design-ui]\ncommand = "old"\nargs = ["old", "--project", "${PROJECT}"]\nstartup_timeout_sec = 45\n\n[mcp_servers.design-ui.env]\nA = "1"\n\n[other]\nz = 2\n`;
    const r = run("toml", src);
    expect(r.first).toBe("CHANGE update design-ui");
    const doc = parse(r.after!) as any;
    expect(doc.mcp_servers["design-ui"]).toEqual({ ...ENTRY, startup_timeout_sec: 45, env: { A: "1" } });
    expect(doc.other).toEqual({ z: 2 });
    expect(r.after!.endsWith("[other]\nz = 2\n")).toBe(true);
  });

  it("keeps CRLF line endings and comments elsewhere", () => {
    const src = `# keep me\r\nmodel = "x"\r\n\r\n[mcp_servers.design-ui]\r\ncommand = "a"\r\nargs = ["x", "--project", "${PROJECT}"]\r\n\r\n[p]\r\nk = 1 # c\r\n`;
    const r = run("toml", src);
    expect(r.after).not.toMatch(/[^\r]\n/);
    expect(r.after!.startsWith("# keep me\r\nmodel = \"x\"\r\n\r\n")).toBe(true);
    expect(r.after!.endsWith("[p]\r\nk = 1 # c\r\n")).toBe(true);
    expect((parse(r.after!) as any).mcp_servers["design-ui"]).toEqual(ENTRY);
    const added = run("toml", `a = 1\r\n`);
    expect(added.after).not.toMatch(/[^\r]\n/);
  });

  it("another project's entry stays; this project gets design-ui-<slug>; a repeat run keeps", () => {
    const src = `[mcp_servers.design-ui]\ncommand = "a"\nargs = ["x", "--project", "/other"]\n`;
    const r = run("toml", src);
    expect(r.first).toBe("CHANGE add design-ui-my-game");
    const doc = parse(r.after!) as any;
    expect(doc.mcp_servers["design-ui"].args).toEqual(["x", "--project", "/other"]);
    expect(doc.mcp_servers["design-ui-my-game"]).toEqual(ENTRY);
    expect(r.after!.startsWith(src)).toBe(true);
    const again = spawnSync("node", [CJS, "toml", r.file, "/usr/bin/node", SERVER, PROJECT, "0"], { encoding: "utf8" });
    expect(again.stdout.trim()).toBe("KEEP design-ui-my-game");
  });

  it("refuses an invalid file and writes nothing; writes a .bak once", () => {
    const bad = run("toml", "a = = 1\n");
    expect(bad.first).toMatch(/^FAIL .*not valid TOML/);
    expect(bad.after).toBe("a = = 1\n");
    const ok = run("toml", "a = 1\n");
    expect(fs.readFileSync(`${ok.file}.design-ui.bak`, "utf8")).toBe("a = 1\n");
    fs.appendFileSync(ok.file, "b = 2\n");
    spawnSync("node", [CJS, "toml", ok.file, "/usr/bin/node", SERVER, "/other/proj", "0"], { encoding: "utf8" });
    expect(fs.readFileSync(`${ok.file}.design-ui.bak`, "utf8")).toBe("a = 1\n");
  });

  it("dry run writes nothing", () => {
    const r = run("toml", "a = 1\n", true);
    expect(r.first).toBe("CHANGE add design-ui");
    expect(r.after).toBe("a = 1\n");
  });
});

describe("client-config.cjs (JSON)", () => {
  it("keeps user keys of this project's entry and other servers", () => {
    const src = JSON.stringify({ mcpServers: { "design-ui": { command: "a", args: ["x", "--project", PROJECT], env: { A: "1" }, disabled: false }, o: { command: "o" } } }, null, 2) + "\n";
    const r = run("json", src);
    expect(r.first).toBe("CHANGE update design-ui");
    expect(JSON.parse(r.after!).mcpServers).toEqual({ "design-ui": { ...ENTRY, env: { A: "1" }, disabled: false }, o: { command: "o" } });
  });

  it("uses design-ui-<slug> next to another project's entry", () => {
    const src = JSON.stringify({ mcpServers: { "design-ui": { command: "a", args: ["x", "--project", "/other"] } } }) + "\n";
    const r = run("json", src);
    expect(r.first).toBe("CHANGE add design-ui-my-game");
    const j = JSON.parse(r.after!);
    expect(j.mcpServers["design-ui"].args[2]).toBe("/other");
    expect(j.mcpServers["design-ui-my-game"]).toEqual(ENTRY);
  });

  it("fails on JSONC and on a BOM without writing", () => {
    const jsonc = run("json", '{\n // c\n "mcpServers": {}\n}\n');
    expect(jsonc.first).toMatch(/^FAIL .*not plain JSON/);
    expect(jsonc.after).toBe('{\n // c\n "mcpServers": {}\n}\n');
    const bom = run("json", "﻿{}\n");
    expect(bom.first).toMatch(/^FAIL/);
  });
});
