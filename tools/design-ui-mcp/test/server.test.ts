import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readConfig } from "../src/config.js";
import { RULES } from "../src/exporter.js";
import type { Pipeline } from "../src/pipeline.js";
import { RULE_SUMMARIES } from "../src/rule-table.js";
import { Runtime } from "../src/runtime.js";
import { createServer, createUnconfiguredServer, TOOL_NAMES, VERSION } from "../src/server.js";
import { screenStatus } from "../src/status.js";
import { fileURLToPath } from "node:url";
import { call, connect, startStubBridge, tempDir, tempProject, writeZip, type StubBridge } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fast = { pollIntervalMs: 10, settleMs: 20, compileTimeoutMs: 5000 };
/** One warm browser for the whole file, like a server lifetime. */
const runtime = new Runtime();
afterAll(async () => { await runtime.close(); });

let bridge: StubBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

/** Export stand-in: writes screen.ir.json into the export folder (the real exporter is not installed yet). */
function stubPipeline(): Pipeline & { exports: string[] } {
  const exports: string[] = [];
  return {
    exports,
    exportScreen: async (entry, _kit, outDir) => {
      exports.push(entry);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "screen.ir.json"), JSON.stringify({ irVersion: 1, source: fs.readFileSync(entry, "utf8").length }));
      return { ok: true, findings: [] };
    },
    compareScreen: null,
  };
}

const NO_EXPORT: Pipeline = { exportScreen: null, compareScreen: null };

async function serverFor(dir: string, pipeline?: Pipeline): Promise<Client> {
  return connect(createServer(readConfig(dir), { runtime, pipeline, runnerOptions: fast }));
}

describe("server surface", () => {
  it("lists exactly the 7 tools and the rules resource", async () => {
    const p = tempProject();
    const client = await serverFor(p.dir);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...TOOL_NAMES].sort());
    expect(tools).toEqual(["design_ui_import", "design_ui_kit_sync", "design_ui_lint", "design_ui_list", "design_ui_rules", "design_ui_status", "design_ui_verify"]);
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual(["design-ui://rules"]);
    const res = await client.readResource({ uri: "design-ui://rules" });
    expect((res.contents[0] as { text: string }).text).toContain("U-CSS-001");
  });

  it("gives clients instructions with the loop and what is live", async () => {
    const p = tempProject();
    const client = await serverFor(p.dir);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/design_ui_rules[\s\S]*design_ui_lint[\s\S]*design_ui_import[\s\S]*design_ui_verify/);
    expect(instructions).toMatch(/not available yet/i);
    expect(client.getServerVersion()).toMatchObject({ name: "design-ui", version: VERSION });
  });

  it("matches the package version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("design_ui_rules", () => {
  it("returns RULES.md, the allowed CSS, attributes, text styles, fonts and every lint rule", async () => {
    const p = tempProject();
    const r = await call(await serverFor(p.dir), "design_ui_rules");
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("U-CSS-001");
    for (const rule of RULES) expect(r.text).toContain(rule.id);
    expect(r.text).toContain("data-u-screen");
    expect(r.text).toContain("label-bold");
    expect(r.text).toContain("Inter UI");
    expect(r.text).toMatch(/display/);
    expect(r.data.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("has a summary only for rules the linter has", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const id of Object.keys(RULE_SUMMARIES)) expect(ids.has(id), id).toBe(true);
  });
});

describe("design_ui_lint", () => {
  it("fails a display:grid design with a U-CSS-001 finding", async () => {
    const p = tempProject();
    p.addScreen("grid-screen", "grid-screen");
    const r = await call(await serverFor(p.dir), "design_ui_lint", { design: "grid-screen" });
    expect(r.isError).toBe(true);
    expect(r.data.findings.some((f: { ruleId: string }) => f.ruleId === "U-CSS-001")).toBe(true);
    expect(r.text).toContain("U-CSS-001");
    expect(Object.keys(r.data.timings)).toEqual(expect.arrayContaining(["kit", "browser", "load", "lint", "total"]));
  });

  it("passes a clean design (absolute file path) and reuses the warm browser", async () => {
    const p = tempProject();
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_lint", { design: path.join(dir, "screen.html") });
    expect(r.text).not.toContain("U-");
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ ok: true, errors: 0 });
    const launches = runtime.browserLaunches;
    await call(client, "design_ui_lint", { design: "clean-screen" });
    expect(runtime.browserLaunches).toBe(launches);
  });

  it("lints a ZIP and rejects one with ../evil.html", async () => {
    const p = tempProject();
    const html = fs.readFileSync(path.join(p.addScreen("clean-screen", "clean-screen"), "screen.html"), "utf8");
    writeZip(path.join(p.designRoot, "ok.zip"), [{ name: "clean/screen.html", data: html }]);
    writeZip(path.join(p.designRoot, "evil.zip"), [{ name: "screen.html", data: html }, { name: "../evil.html", data: "x" }]);
    const client = await serverFor(p.dir);
    const ok = await call(client, "design_ui_lint", { design: "ok.zip" });
    expect(ok.isError).toBeFalsy();
    const evil = await call(client, "design_ui_lint", { design: "evil.zip" });
    expect(evil.isError).toBe(true);
    expect(evil.text).toContain("../evil.html");
    expect(fs.existsSync(path.join(p.dir, "evil.html"))).toBe(false);
  });

  it("names a design that does not exist", async () => {
    const p = tempProject();
    const r = await call(await serverFor(p.dir), "design_ui_lint", { design: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
  });
});

describe("design_ui_list and design_ui_status", () => {
  it("lists screens with their state and the bridge as not-found, then connected", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const a = await call(client, "design_ui_list");
    expect(a.isError).toBeFalsy();
    expect(a.data.screens).toEqual([expect.objectContaining({ screen: "clean-screen", state: "new", entry: "screen.html" })]);
    expect(a.data.unity.bridge).toBe("not-found");
    bridge = await startStubBridge(p.dir);
    const b = await call(client, "design_ui_list");
    expect(b.data.unity).toMatchObject({ bridge: "connected", port: bridge.port });
    expect(b.text).toMatch(/connected/);
  });

  it("reports what this version supports when called without a screen", async () => {
    const p = tempProject();
    const r = await call(await serverFor(p.dir), "design_ui_status");
    expect(r.isError).toBeFalsy();
    expect(r.data.version).toBe(VERSION);
    expect(r.data.tools.design_ui_lint.available).toBe(true);
    expect(r.data.tools.design_ui_import.available).toBe(true);
    expect(r.data.tools.design_ui_import.note).toMatch(/export live.*Unity compile not available yet/i);
    expect(r.data.pipeline).toEqual({ export: true, compare: false });
    expect(r.data.tools.design_ui_verify.available).toBe(false);
    expect(r.data.config).toMatchObject({ ok: true, designRoot: p.designRoot });
  });

  it("rejects a screen id outside designRoot", async () => {
    const p = tempProject();
    const r = await call(await serverFor(p.dir), "design_ui_status", { screen: "../Assets" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/designRoot/);
  });
});

describe("design_ui_import", () => {
  it("is not available without the export step, names it, and does not call Unity", async () => {
    const p = tempProject();
    p.addScreen("clean-screen", "clean-screen");
    const r = await call(await serverFor(p.dir, NO_EXPORT), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available yet/i);
    expect(r.text).toMatch(/export/);
    expect(p.runnerCalls()).toEqual([]);
  });

  it("exports, calls the command runner with {exportDir} and records last-import.json", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBeFalsy();
    const exportDir = path.join(dir, ".design-ui", "export");
    expect(p.runnerCalls()).toEqual([`import|${p.dir}|Assets/DesignUi/DesignUiProfile.asset|${exportDir}| env=${exportDir}`]);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"));
    expect(rec).toMatchObject({ screen: "clean-screen", via: "command" });
    expect(rec.sourceSha).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.irSha).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rec.importedAt).toBe("string");
    expect(r.data.timings).toHaveProperty("unity");

    const cfg = readConfig(p.dir);
    expect(screenStatus(cfg, "clean-screen").state).toBe("imported");
    fs.appendFileSync(path.join(dir, "screen.html"), "\n<!-- changed -->\n");
    expect(screenStatus(cfg, "clean-screen").state).toBe("design-changed");
  });

  it("skips export and the Unity call when nothing changed", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const again = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(again.isError).toBeFalsy();
    expect(again.data).toMatchObject({ exported: false, unityCalled: false });
    expect(pipeline.exports).toHaveLength(1);
    expect(p.runnerCalls()).toHaveLength(1);
  });

  it("fails with the exit code and log tail of a failing runner", async () => {
    const p = tempProject({ prefer: "command", exit: 3 });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exit 3");
    expect(r.text).toContain("stub-runner: done");
    expect(fs.existsSync(path.join(dir, ".design-ui", "last-import.json"))).toBe(false);
  });

  it("fails without a bridge when the editor route is preferred, naming the project", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Unity Editor bridge not found for ${p.dir}`);
    expect(p.runnerCalls()).toEqual([]);
  });

  it("stops at lint errors", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("grid-screen", "grid-screen");
    const pipeline: Pipeline = {
      exportScreen: async () => ({ ok: false, findings: [{ ruleId: "U-CSS-001", severity: "error", path: "div.g", detail: "display: grid", fix: "flex" }] }),
      compareScreen: null,
    };
    const r = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "grid-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("U-CSS-001");
    expect(p.runnerCalls()).toEqual([]);
  });

  it("runs the real export on the warm browser, then reaches the Unity step (stubbed runner)", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "inbox-mini");
    fs.cpSync(path.resolve(here, "../../design-export/test/fixtures/export/inbox-mini"), dir, { recursive: true });
    fs.renameSync(path.join(dir, "inbox-mini.html"), path.join(dir, "screen.html"));
    const launches = runtime.browserLaunches;
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_import", { design: "inbox-mini" });
    expect(r.isError).toBeFalsy();
    const exportDir = path.join(dir, ".design-ui", "export");
    for (const f of ["screen.ir.json", "lint-report.json", "export-report.json", "fixtures/sample-data.json", "goldens/boxes.json", "goldens/matrix.json"]) {
      expect(fs.existsSync(path.join(exportDir, f)), f).toBe(true);
    }
    expect(fs.readdirSync(path.join(exportDir, "assets")).some((f) => f.endsWith(".png"))).toBe(true);
    expect(fs.readdirSync(path.join(exportDir, "goldens")).some((f) => f.endsWith(".png"))).toBe(true);
    expect(r.data).toMatchObject({ exported: true, unityCalled: true, code: 0 });
    expect(r.data.timings).toHaveProperty("export");
    expect(p.runnerCalls()).toEqual([`import|${p.dir}|Assets/DesignUi/DesignUiProfile.asset|${exportDir}| env=${exportDir}`]);
    expect(runtime.browserLaunches).toBeLessThanOrEqual(launches + 1);
    const again = await call(client, "design_ui_import", { design: "inbox-mini" });
    expect(again.data).toMatchObject({ exported: false, unityCalled: false });
  }, 120_000);

  it("stops at real lint errors without calling Unity", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "bad");
    fs.mkdirSync(dir);
    fs.copyFileSync(path.resolve(here, "../../design-export/test/fixtures/export/lint-error/bad.html"), path.join(dir, "screen.html"));
    const r = await call(await serverFor(p.dir), "design_ui_import", { design: "bad" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("U-CSS-001");
    expect(fs.readdirSync(path.join(dir, ".design-ui", "export"))).toEqual(["lint-report.json"]);
    expect(p.runnerCalls()).toEqual([]);
  }, 120_000);

  it("validates its arguments", async () => {
    const p = tempProject();
    const client = await serverFor(p.dir, stubPipeline());
    const missing = await call(client, "design_ui_import", { design: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found");
    const outside = tempDir();
    fs.copyFileSync(path.join(p.addScreen("clean-screen", "clean-screen"), "screen.html"), path.join(outside, "screen.html"));
    const elsewhere = await call(client, "design_ui_import", { design: outside });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toMatch(/designRoot/);
  });
});

describe("design_ui_kit_sync", () => {
  it("passes the Unity answer through (code 2: not available yet)", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = { code: 2, log: "Not available yet: kit sync arrives with the import pipeline." };
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not available yet: kit sync arrives with the import pipeline.");
    expect(bridge.requests.some((q) => q.path === "/kit-sync")).toBe(true);
  });

  it("fails when the bridge rejects the token", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir, { tokenInFile: "d".repeat(64) });
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/401/);
  });

  it("succeeds through the command route", async () => {
    const p = tempProject({ prefer: "command" });
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBeFalsy();
    expect(p.runnerCalls()[0]).toMatch(/^kitSync\|/);
  });
});

describe("design_ui_verify", () => {
  it("says it is not available yet before anything else, for an existing screen", async () => {
    const p = tempProject();
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available yet/i);
    const missing = await call(client, "design_ui_verify", { screen: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found");
  });

  it("with compare installed: needs an import first, then captures through the command runner and records the verdict", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = stubPipeline();
    pipeline.compareScreen = async (_e, _u, reportFile) => {
      fs.writeFileSync(reportFile, "<p>report</p>");
      return { pass: false, topIssues: ["header: box +3 px"], notRun: [] };
    };
    const client = await serverFor(p.dir, pipeline);
    const before = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(before.isError).toBe(true);
    expect(before.text).toMatch(/not been imported/);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ verdict: "fail", topIssues: ["header: box +3 px"] });
    expect(p.runnerCalls()[1]).toBe(`capture|${path.join(dir, ".design-ui", "export")}|${path.join(dir, ".design-ui", "unity")}| env=${path.join(dir, ".design-ui", "export")}`);
    const st = screenStatus(readConfig(p.dir), "clean-screen");
    expect(st).toMatchObject({ state: "failed", verdict: "fail", reportPath: path.join(dir, "report.html") });
  });

  it("is not available yet after an import, and never reports a pass", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, stubPipeline());
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available yet/i);
    expect(r.text).not.toMatch(/\bpass\b/i);
    expect(p.runnerCalls()).toHaveLength(1);
  });
});

describe("without design-ui.config.json", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(createUnconfiguredServer(tempDir(), "design-ui.config.json not found", { runtime }));
  });

  it("still lists the 7 tools and serves the rules", async () => {
    expect((await client.listTools()).tools).toHaveLength(7);
    const r = await call(client, "design_ui_rules");
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("U-CSS-001");
  });

  it("answers project tools with the config problem", async () => {
    const r = await call(client, "design_ui_list");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("design-ui.config.json not found");
    const s = await call(client, "design_ui_status");
    expect(s.isError).toBeFalsy();
    expect(s.data.config).toMatchObject({ ok: false });
  });
});
