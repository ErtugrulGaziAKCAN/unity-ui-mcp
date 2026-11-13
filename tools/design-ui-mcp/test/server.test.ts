import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readConfig } from "../src/config.js";
import { RULES } from "../src/exporter.js";
import { INSTALLED_PIPELINE, type Pipeline } from "../src/pipeline.js";
import { encodePng } from "../../design-export/src/compare/png.js";
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
      const ir = JSON.stringify({ irVersion: 1, source: fs.readFileSync(entry, "utf8").length });
      const file = path.join(outDir, "screen.ir.json");
      // like the real exporter: unchanged input keeps the previous export
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === ir) return { ok: true, findings: [], skipped: true };
      exports.push(entry);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, ir);
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
    expect(instructions).toMatch(/Live in this version: .*design_ui_import.*design_ui_verify.*design_ui_kit_sync/);
    expect(instructions).not.toMatch(/not available yet/i);
    expect(client.getServerVersion()).toMatchObject({ name: "design-ui", version: VERSION });
  });

  it("names a Unity step the configuration cannot run, in the instructions and the status", async () => {
    const p = tempProject({ prefer: "editor" });
    p.writeConfig({ unityRunner: { prefer: "editor", captureVia: "editor" } });
    const client = await serverFor(p.dir);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/design_ui_verify: the comparison is live, but the Unity capture cannot run: the com\.unity\.design-ui package has no Editor capture/);
    // the Editor route is live only while the bridge answers; the instructions are written once, so they say so
    expect(instructions).toMatch(/Live while the Unity Editor bridge answers[^\n]*\n- design_ui_import: [^\n]*design_ui_status shows whether it answers/);
    expect(instructions).not.toMatch(/Live in this version: [^\n]*design_ui_import/);
    const r = await call(client, "design_ui_status");
    expect(r.data.tools.design_ui_verify.available).toBe(false);
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: [], capture: [], kitSync: [] } } });
    const s = await call(await serverFor(p.dir), "design_ui_status");
    expect(s.data.tools.design_ui_import).toMatchObject({ available: false });
    expect(s.data.tools.design_ui_import.note).toMatch(/"unityRunner\.command\.import" is not configured/);
    expect(s.data.tools.design_ui_verify.note).toMatch(/"unityRunner\.command\.capture" is not configured/);
    expect(s.data.tools.design_ui_kit_sync.available).toBe(false);
  });

  it("reports the Editor route live only while the bridge answers, and stays fast when it does not", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    p.writeConfig({ unityRunner: { prefer: "editor" } });
    const client = await serverFor(p.dir);

    // no Editor: bridge.json missing
    const closed = await call(client, "design_ui_status");
    for (const tool of ["design_ui_import", "design_ui_kit_sync"]) {
      expect(closed.data.tools[tool], tool).toMatchObject({ available: false });
      expect(closed.data.tools[tool].note, tool).toMatch(/^Editor not reachable: no Unity Editor bridge for this project/);
    }
    expect(closed.text).toMatch(/design_ui_import: Editor not reachable/);

    // bridge.json left behind by an Editor that is gone: refused at once, well under the 500 ms probe limit
    fs.mkdirSync(path.join(p.dir, "Library", "DesignUi"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, "Library", "DesignUi", "bridge.json"), JSON.stringify({ port: 9, token: "b".repeat(64), projectPath: p.dir }));
    const t0 = performance.now();
    const stale = await call(client, "design_ui_status");
    const list = await call(client, "design_ui_list");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(stale.data.tools.design_ui_import.note).toMatch(/^Editor not reachable: bridge\.json names port 9 but nothing answers/);
    expect(list.data.unity.bridge).toBe("not-responding");

    // an open Editor: live, and one probe serves calls a moment apart
    bridge = await startStubBridge(p.dir);
    const open = await call(client, "design_ui_status");
    expect(open.data.tools.design_ui_import).toMatchObject({ available: true });
    expect(open.data.tools.design_ui_import.note).toMatch(/^live: export .*the Unity compile in the open Unity Editor/);
    expect(open.data.tools.design_ui_kit_sync).toMatchObject({ available: true });
    await call(client, "design_ui_list");
    await call(client, "design_ui_status");
    expect(bridge.requests.filter((q) => q.path === "/status")).toHaveLength(1);
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
    expect(r.data.tools.design_ui_import.note).toMatch(/^live: export \(lint, IR, goldens, assets\), then the Unity compile through the configured command/);
    expect(r.data.pipeline).toEqual({ export: true, compare: true, capture: true });
    expect(r.data.tools.design_ui_verify.available).toBe(true);
    expect(r.data.tools.design_ui_verify.note).toMatch(/^live: Unity capture through the configured command .*capture-done\.json/);
    expect(r.data.tools.design_ui_kit_sync.available).toBe(true);
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
    expect(r.text).toContain(`Editor not reachable: Unity Editor bridge not found for ${p.dir}`);
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
    // the exporter's skip is what the tool reports, even when last-import.json is gone
    fs.rmSync(path.join(dir, ".design-ui", "last-import.json"));
    const third = await call(client, "design_ui_import", { design: "inbox-mini" });
    expect(third.data).toMatchObject({ exported: false });
    expect(third.data.timings.export).toBeLessThan(2000);
  }, 120_000);

  it("does not acquire the browser when the export is unchanged", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "inbox-mini");
    fs.cpSync(path.resolve(here, "../../design-export/test/fixtures/export/inbox-mini"), dir, { recursive: true });
    fs.renameSync(path.join(dir, "inbox-mini.html"), path.join(dir, "screen.html"));
    const fresh = new Runtime();
    try {
      const client = await connect(createServer(readConfig(p.dir), { runtime: fresh, runnerOptions: fast }));
      await call(client, "design_ui_import", { design: "inbox-mini" });
      expect(fresh.browserLaunches).toBe(1);
      await fresh.close();
      const again = new Runtime();
      const client2 = await connect(createServer(readConfig(p.dir), { runtime: again, runnerOptions: fast }));
      const r = await call(client2, "design_ui_import", { design: "inbox-mini" });
      expect(r.data).toMatchObject({ exported: false });
      expect(again.browserLaunches).toBe(0);
      await again.close();
    } finally { await fresh.close(); }
  }, 120_000);

  it("a lint failure keeps the previous export and last-import.json", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "inbox-mini");
    fs.cpSync(path.resolve(here, "../../design-export/test/fixtures/export/inbox-mini"), dir, { recursive: true });
    fs.renameSync(path.join(dir, "inbox-mini.html"), path.join(dir, "screen.html"));
    const client = await serverFor(p.dir);
    expect((await call(client, "design_ui_import", { design: "inbox-mini" })).isError).toBeFalsy();
    const lastImport = fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8");
    const ir = fs.readFileSync(path.join(dir, ".design-ui", "export", "screen.ir.json"), "utf8");
    const html = fs.readFileSync(path.join(dir, "screen.html"), "utf8");
    fs.writeFileSync(path.join(dir, "screen.html"), html.replace("display:flex;flex-direction:row;width:300px", "display:grid;width:300px"));
    const r = await call(client, "design_ui_import", { design: "inbox-mini" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("U-CSS-001");
    expect(fs.readFileSync(path.join(dir, ".design-ui", "export", "screen.ir.json"), "utf8")).toBe(ir);
    expect(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8")).toBe(lastImport);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "lint-report.json"), "utf8")).findings)).toContain("U-CSS-001");
    expect(p.runnerCalls()).toHaveLength(1);
  }, 120_000);

  it("stops at real lint errors without calling Unity", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "bad");
    fs.mkdirSync(dir);
    fs.copyFileSync(path.resolve(here, "../../design-export/test/fixtures/export/lint-error/bad.html"), path.join(dir, "screen.html"));
    const r = await call(await serverFor(p.dir), "design_ui_import", { design: "bad" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("U-CSS-001");
    expect(fs.existsSync(path.join(dir, ".design-ui", "export"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".design-ui", "lint-report.json"))).toBe(true);
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

  it("says the Editor is not reachable when its bridge.json names a port nothing answers on", async () => {
    const p = tempProject({ prefer: "editor" });
    fs.mkdirSync(path.join(p.dir, "Library", "DesignUi"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, "Library", "DesignUi", "bridge.json"), JSON.stringify({ port: 9, token: "c".repeat(64), projectPath: p.dir }));
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Kit sync not run: Editor not reachable: Unity Editor bridge on 127\.0\.0\.1:9 did not answer/);
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
  it("does not capture when the configuration cannot run the Unity capture", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    p.writeConfig({ unityRunner: { prefer: "command", captureVia: "editor" } });
    const r = await call(await serverFor(p.dir, { ...stubPipeline(), compareScreen: INSTALLED_PIPELINE.compareScreen, unityCapture: true }), "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot capture: the com\.unity\.design-ui package has no Editor capture/);
    expect(r.data).toMatchObject({ available: false, missing: ["capture"], verdict: null });
    expect(p.runnerCalls()).toEqual([]);
  });

  it("gives no verdict for a capture that exits 0 without its done marker, and never compares it", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: ["sh", "-c", "exit 0"], capture: ["sh", "-c", "mkdir -p \"$0\"", "{outDir}"], kitSync: [] } } });
    let compared = 0;
    const pipeline = { ...stubPipeline(), unityCapture: true };
    pipeline.compareScreen = async () => { compared++; return { pass: true, topIssues: [], notRun: [], compared: 1 }; };
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not finish \(no capture-done\.json\); no verdict/);
    expect(r.data.verdict).toBeNull();
    expect(compared).toBe(0);
  });

  it("with the installed pipeline: needs an import first, captures nothing before it, and names a missing screen", async () => {
    const p = tempProject();
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/has not been imported yet/);
    expect(r.data.verdict).toBeNull();
    expect(p.runnerCalls()).toEqual([]);
    const missing = await call(client, "design_ui_verify", { screen: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found");
  });

  it("with compare installed: needs an import first, then captures through the command runner and records the verdict", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = { ...stubPipeline(), unityCapture: true };
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
    expect(p.runnerCalls()[1]).toBe(`capture|${path.join(dir, ".design-ui", "export")}|${path.join(dir, ".design-ui", "unity.next")}| env=${path.join(dir, ".design-ui", "export")}`);
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

/** Export stand-in that writes a real golden set: two captures (PNG + boxes + matrix) and a minimal IR. */
function goldenPipeline(): Pipeline {
  return {
    exportScreen: async (_entry, _kit, outDir) => {
      const g = path.join(outDir, "goldens");
      fs.mkdirSync(g, { recursive: true });
      const w = 64, h = 48, data = new Uint8Array(w * h * 4);
      for (let p = 0; p < w * h; p++) data.set(p % w >= 16 && p % w < 48 && p / w >= 8 && p / w < 40 ? [200, 60, 60, 255] : [20, 30, 40, 255], p * 4);
      const el = (x: number, y: number, ww: number, hh: number) => ({ x, y, w: ww, h: hh, visible: true, text: false, lines: [] });
      const boxes: Record<string, unknown> = {};
      const captures = ["default@64x48", "hover@64x48"].map((name) => {
        fs.writeFileSync(path.join(g, `${name}.png`), encodePng({ w, h, data }));
        boxes[name] = { capture: name, viewport: [w, h], scale: 1, external: [], elements: { root: el(0, 0, w, h), card: el(16, 8, 32, 32) } };
        return { name, state: name.split("@")[0], viewport: [w, h], pseudo: null, apply: [], coverage: null, anim: null };
      });
      fs.writeFileSync(path.join(g, "boxes.json"), JSON.stringify(boxes));
      fs.writeFileSync(path.join(g, "matrix.json"), JSON.stringify({ chromium: "test", platform: "test", captures, unsampled: [] }));
      fs.writeFileSync(path.join(outDir, "screen.ir.json"), JSON.stringify({ irVersion: 1, screen: "clean-screen", root: { id: "root", children: [{ id: "card", children: [] }] } }));
      fs.writeFileSync(path.join(outDir, "export-report.json"), JSON.stringify({ screen: "clean-screen", timings: { lint: 11 }, totalMs: 99 }));
      return { ok: true, findings: [], timings: { total: 99 } };
    },
    compareScreen: INSTALLED_PIPELINE.compareScreen,
    unityCapture: true,
  };
}
/** A capture command that copies the goldens into {outDir} (a perfect Unity), optionally without some files. */
const copyCapture = (without: string[] = []) => ({
  unityRunner: {
    prefer: "command",
    command: {
      import: ["sh", "-c", "exit 0"],
      capture: ["sh", "-c", `mkdir -p "$1" && cp "$0"/goldens/*.png "$0"/goldens/boxes.json "$1"/ && echo '{"runId":"t","jobs":2,"captured":2,"notCaptured":0}' > "$1"/capture-done.json && rm -f ${without.map((f) => `"$1/${f}"`).join(" ") || '"$1/none"'}`, "{exportDir}", "{outDir}"],
      kitSync: ["sh", "-c", "exit 0"],
    },
  },
});

describe("design_ui_verify with the installed comparison", () => {
  it("says the Unity capture is not available yet and runs nothing, even after an import", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, { ...stubPipeline(), compareScreen: INSTALLED_PIPELINE.compareScreen });
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available yet: the Unity capture/);
    expect(r.data).toMatchObject({ available: false, missing: ["capture"], verdict: null });
    expect(p.runnerCalls().map((c) => c.split("|")[0])).toEqual(["import"]);
  });

  it("captures, compares and writes report.html, verdict.json and the verdict (pass)", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig(copyCapture());
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, goldenPipeline());
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).isError).toBeFalsy();
    // a stale capture from an earlier run is never compared
    fs.mkdirSync(path.join(dir, ".design-ui", "unity.next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".design-ui", "unity.next", "stale@64x48.png"), "x");
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.text).toMatch(/^PASS: clean-screen/);
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ verdict: "pass", compared: 2, notRun: [], extra: [], reportPath: path.join(dir, "report.html") });
    // lint from the exporter's report; export, import and capture as this server measured them
    expect(r.data.steps).toMatchObject({ lint: 11 });
    expect(typeof r.data.steps.export).toBe("number");
    expect(r.data.steps.capture).toBeGreaterThanOrEqual(0);
    expect(r.data.steps).toHaveProperty("import");
    const html = fs.readFileSync(path.join(dir, "report.html"), "utf8");
    expect(html).toContain("default@64x48");
    expect(html).toContain("PASS");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "compare", "verdict.json"), "utf8"))).toMatchObject({ pass: true });
    // published: captures in place, no staging left, the report links the published captures
    expect(fs.readdirSync(path.join(dir, ".design-ui", "unity")).sort()).toEqual(["boxes.json", "capture-done.json", "default@64x48.png", "hover@64x48.png"]);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity.next"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".design-ui", "compare.next"))).toBe(false);
    expect(html).toContain('src=".design-ui/unity/default%4064x48.png"');
    expect(screenStatus(readConfig(p.dir), "clean-screen")).toMatchObject({ state: "verified", verdict: "pass" });
    // the report and the bookkeeping do not change the design's source hash
    expect(screenStatus(readConfig(p.dir), "clean-screen").sourceSha).toBe(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8")).sourceSha);
  });

  it("fails a screen with a capture Unity did not produce, and gives no verdict when Unity produced nothing", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig(copyCapture(["hover@64x48.png"]));
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, goldenPipeline());
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ verdict: "fail", notRun: ["hover@64x48"], compared: 1 });
    expect(r.text).toContain("Not run: hover@64x48");
    expect(fs.readFileSync(path.join(dir, "report.html"), "utf8")).toContain("NOT RUN");

    const report = fs.readFileSync(path.join(dir, "report.html"));
    const lastVerify = fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"));
    p.writeConfig(copyCapture(["default@64x48.png", "hover@64x48.png", "boxes.json"]));
    const client2 = await serverFor(p.dir, goldenPipeline());
    const none = await call(client2, "design_ui_verify", { screen: "clean-screen" });
    expect(none.isError).toBe(true);
    expect(none.data.verdict).toBeNull();
    expect(none.text).toMatch(/wrote no boxes\.json; no verdict\. The previous report and verdict are unchanged/);
    // the earlier report, its captures and verdict stay exactly as they were
    expect(fs.readFileSync(path.join(dir, "report.html")).equals(report)).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json")).equals(lastVerify)).toBe(true);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity", "default@64x48.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity.next"))).toBe(false);
    expect(screenStatus(readConfig(p.dir), "clean-screen").verdict).toBe("fail");

    // a capture folder without the capture-done marker is an unfinished capture: no verdict either
    p.writeConfig(copyCapture(["capture-done.json"]));
    const client3 = await serverFor(p.dir, goldenPipeline());
    const unfinished = await call(client3, "design_ui_verify", { screen: "clean-screen" });
    expect(unfinished.isError).toBe(true);
    expect(unfinished.data.verdict).toBeNull();
    expect(unfinished.text).toMatch(/did not finish \(no capture-done\.json\); no verdict/);
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
