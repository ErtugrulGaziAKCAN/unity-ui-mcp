import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readConfig } from "../src/config.js";
import { RULES } from "../src/exporter.js";
import { OLD_PACKAGE_NAME, PACKAGE_NAME } from "../src/package-stamp.js";
import { INSTALLED_PIPELINE, type Pipeline } from "../src/pipeline.js";
import { encodePng } from "../../design-export/src/compare/png.js";
import { RULE_SUMMARIES } from "../src/rule-table.js";
import { Runtime } from "../src/runtime.js";
import { createServer, createUnconfiguredServer, TOOL_NAMES, VERSION } from "../src/server.js";
import { screenStatus } from "../src/status.js";
import { parseScreenContract } from "../../design-export/src/contract.js";
import { wiringOf } from "../src/tools/import.js";
import { keepFailedRun } from "../src/tools/verify.js";
import { kitViewports } from "../src/tools/rules.js";
import { fileURLToPath } from "node:url";
import { call, connect, manualClock, startStubBridge, STUB_RUNNER, tempDir, tempProject, writeZip, type StubBridge, FIXTURES } from "./helpers.js";

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
      const html = fs.readFileSync(entry, "utf8");
      // the real IR names its screen with the page's data-u-screen
      const ir = JSON.stringify({ irVersion: 2, screen: /data-u-screen="([^"]+)"/.exec(html)?.[1], source: { path: path.basename(entry), length: html.length } });
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
/** An import command that only confirms the export it was given (import-done.json with the IR's SHA-256), like Unity's. */
const CONFIRMING_IMPORT = ["sh", STUB_RUNNER, "--log", "/dev/null", "import", "{exportDir}"];

async function serverFor(dir: string, pipeline?: Pipeline): Promise<Client> {
  return connect(createServer(readConfig(dir), { runtime, pipeline, runnerOptions: fast }));
}

describe("server surface", () => {
  it("lists exactly the 9 tools and the rules resource", async () => {
    const p = tempProject();
    const client = await serverFor(p.dir);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...TOOL_NAMES].sort());
    expect(tools).toEqual(["design_ui_brief", "design_ui_clean", "design_ui_import", "design_ui_kit_sync", "design_ui_lint", "design_ui_list", "design_ui_rules", "design_ui_status", "design_ui_verify"]);
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
    expect(instructions).toMatch(/Live in this version: .*design_ui_import.*design_ui_verify.*design_ui_kit_sync.*design_ui_clean/);
    expect(instructions).not.toMatch(/not available yet/i);
    expect(instructions).toMatch(/design_ui_brief/);
    expect(instructions).toMatch(/screen\.contract\.json beside the design, written from the\s+project/);
    expect(client.getServerVersion()).toMatchObject({ name: "design-ui", version: VERSION });
  });

  it("names a Unity step the configuration cannot run, in the instructions and the status", async () => {
    const p = tempProject({ prefer: "editor" });
    p.writeConfig({ unityRunner: { prefer: "editor", captureVia: "editor" } });
    const client = await serverFor(p.dir);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/design_ui_verify: the comparison is live, but the Unity capture cannot run: the com\.ertugrulgaziakcan\.design-ui package has no Editor capture/);
    // the Editor route is live only while the bridge answers; the instructions are written once, so they say so
    expect(instructions).toMatch(/Live while the Unity Editor bridge answers[^\n]*\n- design_ui_import: [^\n]*design_ui_status shows whether it answers/);
    expect(instructions).not.toMatch(/Live in this version: [^\n]*design_ui_import/);
    const r = await call(client, "design_ui_status");
    expect(r.data.tools.design_ui_verify.available).toBe(false);
    // the kit's viewports by class
    expect(r.data.viewports).toEqual({ exact: [[2560, 1440], [1920, 1080], [1280, 720]], scaled: [] });
    expect(r.text).toMatch(/^viewports: exact 2560×1440, 1920×1080, 1280×720 \(exact: every kit value/m);
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

const REPO_KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit");

describe("design_ui_rules", () => {
  /** The two text parts of an answer: the Markdown contract and the compact machine JSON. */
  const parts = (r: { content: unknown }) => (r.content as { type: string; text: string }[]).map((c) => c.text);
  const headings = (md: string) => md.split("\n").filter((l) => l.startsWith("## "));

  it("returns the kit's RULES.md once with its section index; section json is the compact JSON: rules with severity and fix, allowed CSS, text styles, fonts", async () => {
    const p = tempProject();
    p.writeConfig({ kitDir: REPO_KIT });
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_rules");
    expect(r.isError).toBeFalsy();
    expect(parts(r)).toHaveLength(1);
    const [md] = parts(r);
    expect(md).toContain(fs.readFileSync(path.join(REPO_KIT, "RULES.md"), "utf8").trim());
    expect(md).toMatch(/^Sections \(design_ui_rules \{ section \} returns one\): .*text-styles.*lint-rules.*; json is the same contract/m);
    const hs = headings(md);
    expect(new Set(hs).size).toBe(hs.length); // no section twice
    expect(r.data.rules).toBeUndefined(); // the data comes with section json only
    const js = await call(client, "design_ui_rules", { section: "json" });
    const json = parts(js)[0];
    const data = JSON.parse(json);
    expect(Object.keys(data.rules)).toEqual(RULES.map((x) => x.id));
    for (const [id, [severity, fix]] of Object.entries(data.rules) as [string, [string, string]][]) {
      expect(severity).toBe(RULES.find((x) => x.id === id)!.severity);
      expect(fix.length).toBeGreaterThan(0);
    }
    expect(data.css.properties.direct).toContain("width");
    expect(data.css.properties.direct).toContain("filter");
    expect(data.css.filterFunctions).toEqual(["invert"]);
    expect(data.css.properties.rejected["backdrop-filter"]).toBe("U-CSS-007");
    expect(data.textStyles).toContainEqual({ name: "body", fontSize: 24, lineHeight: 32, weight: 400, class: ".text-body" });
    expect(json).not.toContain("\n  "); // compact
    expect(r.data.rulesSource).toBe("file");
    expect(r.data.sections).toContain("text-styles");
    expect(r.data.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("stays within the 50 KB budget, its data included", async () => {
    const p = tempProject();
    p.writeConfig({ kitDir: REPO_KIT });
    const r = await call(await serverFor(p.dir), "design_ui_rules");
    const size = Buffer.byteLength(parts(r).join("\n") + JSON.stringify(r.data), "utf8");
    expect(size).toBeLessThan(50_000);
  });

  it("a kit without RULES.md gets one generated from its own files, never the repository's text styles", async () => {
    const p = tempProject(); // the lint test kit: no RULES.md, the previous text-style table (caption 12/15)
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_rules");
    const [md] = parts(r);
    const json = parts(await call(client, "design_ui_rules", { section: "json" }))[0];
    expect(r.data.rulesSource).toBe("generated");
    expect(md).toContain("| caption | `.text-caption` | 12 | 15 | 400 |");
    expect(md).not.toContain("| caption | `.text-caption` | 12 | 16 | 400 |");
    for (const rule of RULES) expect(md).toContain(rule.id);
    expect(md).toContain("data-u-screen");
    expect(JSON.parse(json).textStyles).toContainEqual({ name: "caption", fontSize: 12, lineHeight: 15, weight: 400, class: ".text-caption" });
    expect(JSON.parse(json).fonts).toMatchObject({ "Inter UI": ["400", "700"] });
    const hs = headings(md);
    expect(new Set(hs).size).toBe(hs.length);
  });

  it("answers one section: a Markdown section by name, or only the JSON; an unknown name lists the sections", async () => {
    const p = tempProject();
    p.writeConfig({ kitDir: REPO_KIT });
    const client = await serverFor(p.dir);
    const ts = await call(client, "design_ui_rules", { section: "text-styles" });
    expect(ts.isError).toBeFalsy();
    expect(parts(ts)).toHaveLength(1);
    expect(parts(ts)[0].startsWith("## Text styles")).toBe(true);
    expect(parts(ts)[0]).not.toContain("## Lint rules");
    const js = await call(client, "design_ui_rules", { section: "json" });
    expect(parts(js)).toHaveLength(1);
    expect(Object.keys(JSON.parse(parts(js)[0]).rules)).toHaveLength(RULES.length);
    const bad = await call(client, "design_ui_rules", { section: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/lint-rules/);
  });

  it("has a summary only for rules the linter has", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const id of Object.keys(RULE_SUMMARIES)) expect(ids.has(id), id).toBe(true);
  });
});

describe("design_ui_brief", () => {
  it("returns the brief of a valid contract", async () => {
    const p = tempProject();
    const dir = p.addScreen("clean-screen", "clean-screen");
    fs.writeFileSync(path.join(dir, "screen.contract.json"), JSON.stringify({
      contract: 1, screen: "clean.screen", kind: "new",
      actions: [{ name: "open-it", handler: null, origin: "requested", note: "user, 2026-11-16: add it" }],
      texts: [{ key: "clean.screen.title", en: "Title", origin: "existing" }, { key: "clean.screen.hint", en: "Hint", origin: "requested", note: "user, 2026-11-16: add a hint" }],
    }));
    const r = await call(await serverFor(p.dir), "design_ui_brief", { screen: "clean-screen" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^# Design brief: clean\.screen\n/);
    expect(r.data.brief).toMatch(/^# Design brief: clean\.screen\n/);
    expect(r.data).toMatchObject({ screen: "clean.screen", contract: "valid", dependencies: ["action open-it: user, 2026-11-16: add it"] });
  });

  it("errors on an absent or invalid contract with the fix", async () => {
    const p = tempProject();
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const absent = await call(client, "design_ui_brief", { screen: "clean-screen" });
    expect(absent.isError).toBe(true);
    expect(absent.text).toContain("no screen.contract.json in clean-screen");
    expect(absent.text).toContain('write screen.contract.json from the project (see design_ui_rules, "Screen contract")');
    fs.writeFileSync(path.join(dir, "screen.contract.json"), JSON.stringify({ contract: 2 }));
    const bad = await call(client, "design_ui_brief", { screen: "clean-screen" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("screen.contract.json: contract must be 1");
    expect(bad.text).toContain("write screen.contract.json from the project");
  });

  /** A contract for the screen "calendar" (an empty new screen: one requested action). */
  const CALENDAR = JSON.stringify({
    contract: 1, screen: "calendar", kind: "new",
    actions: [{ name: "open-day", handler: null, origin: "requested", note: "user, 2026-11-16: open a day" }],
  });

  it("briefs a folder that holds only the contract: nothing is designed yet", async () => {
    const p = tempProject();
    const dir = path.join(p.designRoot, "calendar");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "screen.contract.json"), CALENDAR);
    const client = await serverFor(p.dir);
    for (const screen of ["calendar", dir]) {
      const r = await call(client, "design_ui_brief", { screen });
      expect(r.isError, r.text).toBeFalsy();
      expect(r.text).toMatch(/^# Design brief: calendar\n/);
      expect(r.data).toMatchObject({ screen: "calendar", contract: "valid", dependencies: ["action open-day: user, 2026-11-16: open a day"] });
    }
    const missing = await call(client, "design_ui_brief", { screen: "nowhere" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("design not found: nowhere");
  });

  it("briefs a canvas folder with several artboards, by the folder or by an artboard", async () => {
    const p = tempProject();
    const dir = path.join(p.designRoot, "canvas");
    fs.mkdirSync(dir);
    const page = fs.readFileSync(path.join(here, "fixtures", "designs", "clean-screen", "screen.html"), "utf8").replace('data-u-screen="clean.screen"', 'data-u-screen="calendar"');
    for (const n of ["calendar-month.dc.html", "calendar-empty-day.dc.html"]) fs.writeFileSync(path.join(dir, n), page);
    fs.writeFileSync(path.join(dir, "screen.contract.json"), CALENDAR);
    const client = await serverFor(p.dir);
    for (const screen of ["canvas", "canvas/calendar-month.dc.html"]) {
      const r = await call(client, "design_ui_brief", { screen });
      expect(r.isError, r.text).toBeFalsy();
      expect(r.data).toMatchObject({ screen: "calendar", contract: "valid" });
    }
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

  it("notes a design without a contract apart from warnings", async () => {
    const p = tempProject();
    p.addScreen("clean-screen", "clean-screen");
    const r = await call(await serverFor(p.dir), "design_ui_lint", { design: "clean-screen" });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ ok: true, errors: 0, warnings: 0, notes: 1 });
    expect(r.data.findings.map((f: { ruleId: string }) => f.ruleId)).toContain("I-CON-001");
    expect(r.text).toMatch(/^Lint passed: no errors, 1 note in clean-screen\/screen\.html\./);
  });

  it("checks the design against the contract beside it", async () => {
    const p = tempProject();
    const dir = p.addScreen("clean-screen", "clean-screen");
    const file = path.join(dir, "screen.html");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('<div class="g"', '<div class="g" data-u-id="go" data-u-action="open-it"'));
    fs.writeFileSync(path.join(dir, "screen.contract.json"), JSON.stringify({
      contract: 1, screen: "clean.screen", kind: "new", values: [], actions: [], states: [], repeats: [],
      texts: [{ key: "clean.screen.title", en: "Title", origin: "existing" }],
    }));
    const r = await call(await serverFor(p.dir), "design_ui_lint", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.data.ok).toBe(false);
    expect(r.data.findings.map((f: { ruleId: string }) => f.ruleId)).toContain("U-CON-002");
    expect(r.data.notes).toBe(0);
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
    expect(a.data.screens).toEqual([expect.objectContaining({ screen: "clean.screen", folder: "clean-screen", state: "new", entry: "screen.html" })]);
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

  it("reports the package id before 0.1.0 when the project still lists it, and how to replace it", async () => {
    const p = tempProject();
    const clean = await call(await serverFor(p.dir), "design_ui_status");
    expect(clean.data.package).toEqual({ id: PACKAGE_NAME, oldId: null });
    expect(clean.text).not.toMatch(/old package id/);
    fs.mkdirSync(path.join(p.dir, "Packages"));
    fs.writeFileSync(path.join(p.dir, "Packages", "manifest.json"), JSON.stringify({
      testables: [OLD_PACKAGE_NAME],
      dependencies: { [OLD_PACKAGE_NAME]: `https://example.invalid/unity-ui-mcp.git?path=/packages/${OLD_PACKAGE_NAME}#main` },
    }));
    const r = await call(await serverFor(p.dir), "design_ui_status");
    expect(r.isError).toBeFalsy();
    expect(r.data.package.oldId).toMatchObject({ id: OLD_PACKAGE_NAME, where: ["Packages/manifest.json (dependencies)", "Packages/manifest.json (testables)"] });
    expect(r.data.package.oldId.fix).toContain("scripts/setup.sh");
    expect(r.text).toContain(`old package id: ${OLD_PACKAGE_NAME} in Packages/manifest.json (dependencies), Packages/manifest.json (testables); the package id is ${PACKAGE_NAME}`);
    expect(r.text).toContain(`path=/packages/${PACKAGE_NAME}`);
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
    expect(rec).toMatchObject({ screen: "clean.screen", entry: "screen.html", via: "command" });
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

  it("calls Unity again for an unchanged export when the package (the compiler) changed", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pkg = path.join(p.dir, "Packages", "com.ertugrulgaziakcan.design-ui");
    fs.mkdirSync(path.join(pkg, "Editor"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "com.ertugrulgaziakcan.design-ui", version: "0.1.0" }));
    fs.writeFileSync(path.join(pkg, "Editor", "Compiler.cs"), "// v1\n");
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"));
    expect(rec.compiler).toMatch(/^sha256:[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(pkg, "Editor", "Compiler.cs"), "// v2: a new element type\n");
    const again = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(again.isError).toBeFalsy();
    expect(again.data).toMatchObject({ exported: false, unityCalled: true });
    expect(pipeline.exports).toHaveLength(1);
    expect(p.runnerCalls()).toHaveLength(2);
    const third = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(third.data).toMatchObject({ unityCalled: false });
    expect(p.runnerCalls()).toHaveLength(2);
  });

  it("calls Unity again for an unchanged export when the screen's generated folder is gone, and records where Unity wrote it", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    // the generated folder Unity names in its done marker (the stub writes Assets/UI/Generated/CleanScreen)
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"));
    expect(rec.output).toBe("Assets/UI/Generated/CleanScreen");
    const generated = path.join(p.dir, "Assets", "UI", "Generated", "CleanScreen");
    expect(fs.existsSync(path.join(generated, ".design-ui.json"))).toBe(true);
    fs.rmSync(generated, { recursive: true });
    const again = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(again.isError).toBeFalsy();
    expect(again.data).toMatchObject({ exported: false, unityCalled: true });
    expect(p.runnerCalls()).toHaveLength(2);
    expect(fs.existsSync(path.join(generated, ".design-ui.json"))).toBe(true);
    // back in place: skipped again; an import recorded before the record named its folder calls Unity once
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).data).toMatchObject({ unityCalled: false });
    const file = path.join(dir, ".design-ui", "last-import.json");
    const { output: _output, ...older } = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify(older));
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).data).toMatchObject({ unityCalled: true });
    expect(p.runnerCalls()).toHaveLength(3);
  });

  it("calls Unity again for an unchanged export when the profile or the kit changed", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const profile = path.join(p.dir, "Assets", "DesignUi", "DesignUiProfile.asset");
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, "referenceLocale: tr\n");
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    fs.writeFileSync(profile, "referenceLocale: tr\nlocales: [en]\n");
    const again = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(again.data).toMatchObject({ unityCalled: true });
    expect(p.runnerCalls()).toHaveLength(2);
    // an import recorded before the record named its kit, profile or package is imported again once
    const file = path.join(p.designRoot, "clean-screen", ".design-ui", "last-import.json");
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...rec, kitSha: "0".repeat(64) }));
    const third = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(third.data).toMatchObject({ unityCalled: true });
    expect(p.runnerCalls()).toHaveLength(3);
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

  it("fails without a bridge when the editor route is preferred, naming the project, before it exports anything", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    // captures a verify kept: an import that exports the screen again removes them; one that cannot reach Unity must not
    const kept = path.join(dir, ".design-ui", "kept-captures");
    fs.mkdirSync(kept, { recursive: true });
    const pipeline = stubPipeline();
    const r = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Editor not reachable: Unity Editor bridge not found for ${p.dir}`);
    expect(r.text).toContain("Nothing was exported or written.");
    expect(r.data).toMatchObject({ exported: false, unityCalled: false });
    expect(pipeline.exports).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(p.runnerCalls()).toEqual([]);
  });

  it("on the command route records an import only when Unity confirms this IR in import-done.json", async () => {
    for (const mode of ["none", "wrong"] as const) {
      const p = tempProject({ prefer: "command", importDone: mode });
      const dir = p.addScreen("clean-screen", "clean-screen");
      const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
      expect(r.isError, mode).toBe(true);
      expect(r.text).toContain("import-done.json");
      expect(r.data).toMatchObject({ unityCalled: true, via: "command", code: 0 });
      expect(fs.existsSync(path.join(dir, ".design-ui", "last-import.json"))).toBe(false);
    }
  });

  it("on the command route never accepts a marker left by an earlier run", async () => {
    const p = tempProject({ prefer: "command", importDone: "none" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = stubPipeline();
    await pipeline.exportScreen!(path.join(dir, "screen.html"), {} as never, path.join(dir, ".design-ui", "export"), async () => { throw new Error("no browser"); });
    const ir = fs.readFileSync(path.join(dir, ".design-ui", "export", "screen.ir.json"));
    const sha = (await import("node:crypto")).createHash("sha256").update(ir).digest("hex");
    fs.writeFileSync(path.join(dir, ".design-ui", "import-done.json"), JSON.stringify({ imports: [{ exportDir: "x", code: 0, irSha: sha }] }));
    const r = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("import-done.json");
  });

  it("on the editor route reports what changed, waits for the script compile and records the import", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = {
      code: 0, log: "Imported clean-screen into Assets/UI/Generated/CleanScreen: 3 files written (55 ms).",
      changed: ["a.uss", "a.uxml", "AView.g.cs"], imported: ["Assets/a.uss", "Assets/a.uxml", "Assets/AView.g.cs"], compiled: ["Assets/AView.g.cs"],
      compiling: true, compileId: 9, ms: 55,
    };
    bridge.compilingPolls = 2;
    bridge.lastCompile = { id: 9, state: "reloaded", ok: true, errors: [] };
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({
      via: "editor", code: 0, unity: { changed: ["a.uss", "a.uxml", "AView.g.cs"], imported: ["Assets/a.uss", "Assets/a.uxml", "Assets/AView.g.cs"], compiled: ["Assets/AView.g.cs"], compiling: true, compileId: 9, ms: 55 },
      compile: { id: 9, state: "reloaded", ok: true },
    });
    expect(r.data.unityTimings).toHaveProperty("compileWait");
    expect(r.text).toMatch(/3 files changed/);
    expect(r.text).toMatch(/scripts compiled/);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"));
    expect(rec.timings).toHaveProperty("compile");
  });

  it("on the editor route shows the import's warnings and errors before the log tail", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = {
      code: 0, log: "Imported clean-screen into Assets/UI/Generated/CleanScreen: 1 file written (5 ms).\nlocalization conflict (not overwritten): a.title",
      changed: ["a.uss"], imported: ["Assets/a.uss"], compiled: [], compiling: false, compileId: null, ms: 5,
      warnings: ["localization conflict (not overwritten): a.title"], errors: [],
    };
    const client = await serverFor(p.dir, stubPipeline());
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ warnings: ["localization conflict (not overwritten): a.title"], errors: [] });
    expect((r.content[0] as { text: string }).text).toMatch(/^Imported clean\.screen into Unity via editor: .*\nUnity warnings \(1\):\n- localization conflict \(not overwritten\): a\.title\nNo screen contract: [^\n]*$/);

    fs.appendFileSync(path.join(p.designRoot, "clean-screen", "screen.html"), "\n<!-- changed -->\n");
    bridge.answer = { code: 1, log: "Import failed; nothing was written for the screen.\n" + "written: x\n".repeat(600), errors: ["the screen id 'x' is taken"], warnings: [] };
    const failed = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as { text: string }).text).toMatch(/^Unity import of clean\.screen failed \(exit 1, via editor\)\.\nUnity errors \(1\):\n- the screen id 'x' is taken\nLog tail:\n/);
  });

  it("on the editor route is an error, and records nothing, when the generated scripts do not compile", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = { code: 0, log: "Imported.", changed: ["AView.g.cs"], imported: ["Assets/AView.g.cs"], compiled: ["Assets/AView.g.cs"], compiling: true, compileId: 2, ms: 9 };
    bridge.lastCompile = { id: 2, state: "failed", ok: false, errors: ["Assets/AView.g.cs(3,1): error CS0101: duplicate type"] };
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("CS0101");
    expect(r.data.compile).toMatchObject({ state: "failed" });
    expect(fs.existsSync(path.join(dir, ".design-ui", "last-import.json"))).toBe(false);
  });

  const editorAnswer = (extra: Record<string, unknown>) => ({
    code: 0, log: "Imported.", changed: ["AView.g.cs"], imported: ["Assets/AView.g.cs"], compiled: ["Assets/AView.g.cs"], compiling: false, compileId: null, ms: 9, ...extra,
  });
  const lastImport = (dir: string) => path.join(dir, ".design-ui", "last-import.json");

  it("on the editor route never records an import whose compile failed inside it (no wait, answered at once)", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = editorAnswer({
      compileId: 4, scriptsFailed: true, lastCompile: { id: 4, state: "failed", ok: false, errors: ["Assets/AView.g.cs(3,1): error CS0101: duplicate type"] },
    });
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("CS0101");
    expect(r.text).toMatch(/importing the same design again changes nothing/i);
    expect(r.data).toMatchObject({ unityCalled: true, compile: { state: "failed" } });
    expect(fs.existsSync(lastImport(dir))).toBe(false);
  });

  it("on the editor route never records an import while the project's scripts do not compile, even with no script change", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = editorAnswer({
      changed: [], imported: [], compiled: [], scriptsFailed: true,
      lastCompile: { id: 1, state: "failed", ok: false, errors: ["Assets/AView.g.cs(3,1): error CS0101: duplicate type"] },
    });
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scripts do not compile/);
    expect(r.text).toContain("CS0101");
    expect(fs.existsSync(lastImport(dir))).toBe(false);
    // and the next import calls Unity again instead of skipping it
    bridge.answer = editorAnswer({ changed: [], imported: [], compiled: [], scriptsFailed: false });
    const again = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(again.isError).toBeFalsy();
    expect(again.data.unityCalled).toBe(true);
    expect(fs.existsSync(lastImport(dir))).toBe(true);
  });

  it("on the editor route an unknown compile result is an error and is not recorded, unless the scripts demonstrably compile", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = editorAnswer({ compiling: true, compileId: 8 });
    bridge.compilingPolls = 1;
    bridge.lastCompile = null; // the Editor restarted: no result for this compile id
    const r = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown/);
    expect(r.data.compile).toMatchObject({ state: "unknown", ok: false });
    expect(fs.existsSync(lastImport(dir))).toBe(false);

    bridge.compilingPolls = 1;
    bridge.scriptsFailed = false;
    const ok = await call(await serverFor(p.dir, stubPipeline()), "design_ui_import", { design: "clean-screen" });
    expect(ok.isError).toBeFalsy();
    expect(ok.data.compile).toMatchObject({ state: "unknown", ok: true });
    expect(fs.existsSync(lastImport(dir))).toBe(true);
  });

  it("on the editor route a compile wait that times out says the import ran, and records nothing", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    bridge.answer = { ...editorAnswer({ compiling: true, compileId: 2 }), warnings: ["orphan screen folder (not deleted): X"], errors: [] };
    bridge.compilingPolls = 1_000_000;
    const client = await connect(createServer(readConfig(p.dir), { runtime, pipeline: stubPipeline(), runnerOptions: { ...fast, compileTimeoutMs: 100 } }));
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Imported the files of clean\.screen .*still compiling.*\nUnity warnings \(1\):\n- orphan screen folder \(not deleted\): X/);
    expect(r.data).toMatchObject({ unityCalled: true, unity: { compileId: 2 }, warnings: ["orphan screen folder (not deleted): X"], errors: [] });
    expect(fs.existsSync(lastImport(dir))).toBe(false);
  });

  it("on the editor route reports the real failure when the Editor closed after a cached 'connected'", async () => {
    const p = tempProject({ prefer: "editor" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    const client = await serverFor(p.dir, stubPipeline());
    expect((await call(client, "design_ui_status")).data.unity.bridge).toBe("connected");
    await bridge.close(); // a crash: bridge.json stays, nothing listens
    bridge = null;
    expect((await call(client, "design_ui_status")).data.unity.bridge).toBe("connected"); // the probe's short cache
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Editor not reachable: Unity Editor bridge on 127\.0\.0\.1:\d+ did not answer POST \/import/);
    expect(fs.existsSync(path.join(dir, ".design-ui", "last-import.json"))).toBe(false);
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

describe("a canvas folder with several artboards", () => {
  const plain = fs.readFileSync(path.join(here, "fixtures", "designs", "clean-screen", "screen.html"), "utf8");
  /** The clean screen as a Claude Design artboard (its style in <helmet>, its body in <x-dc>), screen id "calendar". */
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><x-dc><helmet>${/<style>[\s\S]*<\/style>/.exec(plain)![0]}</helmet>` +
    `${/<body>([\s\S]*)<\/body>/.exec(plain)![1].replace('data-u-screen="clean.screen"', 'data-u-screen="calendar"')}</x-dc></body></html>`;
  /** `<designRoot>/canvas/` with two artboards of the screen "calendar" (the folder name is not the screen id) and canvas.json. */
  function canvas(p: ReturnType<typeof tempProject>): string {
    const dir = path.join(p.designRoot, "canvas");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "calendar-month.dc.html"), html);
    fs.writeFileSync(path.join(dir, "calendar-empty-day.dc.html"), html.replace("Başlık", "Boş gün"));
    fs.writeFileSync(path.join(dir, "canvas.json"), "{}");
    return dir;
  }
  const comparing = () => {
    const pipeline = { ...stubPipeline(), unityCapture: true };
    pipeline.compareScreen = async (_e, _u, reportFile) => {
      fs.writeFileSync(reportFile, "<p>report</p>");
      return { pass: true, topIssues: [], notRun: [], compared: 1 };
    };
    return pipeline;
  };

  it("import takes exactly the artboard it is given; the screen id is its data-u-screen, bookkeeping stays in the folder", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = canvas(p);
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    const r = await call(client, "design_ui_import", { design: "canvas/calendar-empty-day.dc.html" });
    expect(r.isError, r.text).toBeFalsy();
    expect(pipeline.exports).toEqual([path.join(dir, "calendar-empty-day.dc.html")]);
    const exportDir = path.join(dir, ".design-ui", "export");
    expect(p.runnerCalls()).toEqual([`import|${p.dir}|Assets/DesignUi/DesignUiProfile.asset|${exportDir}| env=${exportDir}`]);
    expect(r.data).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", exportDir });
    expect(r.text).toMatch(/^Imported calendar \(canvas\/calendar-empty-day\.dc\.html\) into Unity/);
    expect(r.text).toContain('design_ui_verify { screen: "canvas/calendar-empty-day.dc.html" }');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"));
    expect(rec).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", via: "command" });

    // an absolute path to the other artboard imports that one, into the same bookkeeping folder
    const other = await call(client, "design_ui_import", { design: path.join(dir, "calendar-month.dc.html") });
    expect(other.isError, other.text).toBeFalsy();
    expect(pipeline.exports).toEqual([path.join(dir, "calendar-empty-day.dc.html"), path.join(dir, "calendar-month.dc.html")]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"))).toMatchObject({ screen: "calendar", entry: "calendar-month.dc.html" });
    expect(p.runnerCalls()).toHaveLength(2);
    // the same artboard again is unchanged
    expect((await call(client, "design_ui_import", { design: "canvas/calendar-month.dc.html" })).data).toMatchObject({ exported: false, unityCalled: false, screen: "calendar" });
  });

  it("import of the folder keeps today's behaviour, and its error lists the candidate files", async () => {
    const p = tempProject({ prefer: "command" });
    canvas(p);
    const pipeline = stubPipeline();
    const r = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "canvas" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/several designs in .*canvas: pass the path of the one to use: canvas\/calendar-empty-day\.dc\.html, canvas\/calendar-month\.dc\.html/);
    expect(pipeline.exports).toEqual([]);
    expect(p.runnerCalls()).toEqual([]);
    const notPage = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "canvas/canvas.json" });
    expect(notPage.isError).toBe(true);
    expect(notPage.text).toMatch(/not a design page/);
  });

  it("verify checks the artboard it is given: only the folder's last import, or the folder itself", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = canvas(p);
    const client = await serverFor(p.dir, comparing());
    await call(client, "design_ui_import", { design: "canvas/calendar-empty-day.dc.html" });
    const wrong = await call(client, "design_ui_verify", { screen: "canvas/calendar-month.dc.html" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/canvas\/calendar-month\.dc\.html is not the last import of its screen folder \(calendar-empty-day\.dc\.html/);
    expect(wrong.text).toContain('design_ui_import { design: "canvas/calendar-month.dc.html" }');
    expect(wrong.data.verdict).toBeNull();
    expect(p.runnerCalls().map((c) => c.split("|")[0])).toEqual(["import"]);

    const r = await call(client, "design_ui_verify", { screen: "canvas/calendar-empty-day.dc.html" });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", verdict: "pass" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8"))).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", verdict: "pass" });
    // the folder verifies its last import, as before
    expect((await call(client, "design_ui_verify", { screen: "canvas" })).data).toMatchObject({ verdict: "pass", entry: "calendar-empty-day.dc.html" });
  });

  it("status and list report the artboard: a page that is not the folder's last import is new", async () => {
    const p = tempProject({ prefer: "command" });
    canvas(p);
    const client = await serverFor(p.dir, comparing());
    const before = await call(client, "design_ui_list");
    expect(before.data.screens).toEqual([expect.objectContaining({ screen: "calendar", folder: "canvas", state: "new", entry: null, problem: expect.stringContaining("canvas/calendar-month.dc.html") })]);

    await call(client, "design_ui_import", { design: "canvas/calendar-empty-day.dc.html" });
    await call(client, "design_ui_verify", { screen: "canvas/calendar-empty-day.dc.html" });
    const imported = await call(client, "design_ui_status", { screen: "canvas/calendar-empty-day.dc.html" });
    expect(imported.isError, imported.text).toBeFalsy();
    expect(imported.data).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", state: "verified", verdict: "pass" });
    const other = await call(client, "design_ui_status", { screen: "canvas/calendar-month.dc.html" });
    expect(other.data).toMatchObject({ screen: "calendar", entry: "calendar-month.dc.html", state: "new", verdict: null, lastImportSha: null });
    expect(other.text).toMatch(/^canvas\/calendar-month\.dc\.html: new/);
    expect(other.text).toContain("not the folder's last import (calendar-empty-day.dc.html");
    expect(other.text).not.toContain("never imported");
    const folder = await call(client, "design_ui_status", { screen: "canvas" });
    expect(folder.data).toMatchObject({ screen: "calendar", entry: "calendar-empty-day.dc.html", state: "verified" });
    expect(screenStatus(readConfig(p.dir), "canvas/calendar-month.dc.html").state).toBe("new");
    const after = await call(client, "design_ui_list");
    expect(after.data.screens).toEqual([expect.objectContaining({ screen: "calendar", folder: "canvas", state: "verified", entry: "calendar-empty-day.dc.html" })]);
    // the screen id finds its folder: status and verify by data-u-screen
    expect((await call(client, "design_ui_status", { screen: "calendar" })).data).toMatchObject({ screen: "calendar", folder: path.join(p.designRoot, "canvas"), state: "verified" });
    expect((await call(client, "design_ui_verify", { screen: "calendar" })).data).toMatchObject({ verdict: "pass", entry: "calendar-empty-day.dc.html" });
    expect(after.data.screens[0].problem).toBeUndefined();
  });

  it("lint takes the artboard it is given; the folder's error lists the candidates", async () => {
    const p = tempProject();
    canvas(p);
    const client = await serverFor(p.dir);
    const one = await call(client, "design_ui_lint", { design: "canvas/calendar-month.dc.html" });
    expect(one.isError, one.text).toBeFalsy();
    expect(one.data.entry).toBe(path.join("canvas", "calendar-month.dc.html"));
    const folder = await call(client, "design_ui_lint", { design: "canvas" });
    expect(folder.isError).toBe(true);
    expect(folder.text).toMatch(/pass the path of the one to use: canvas\/calendar-empty-day\.dc\.html, canvas\/calendar-month\.dc\.html/);
  }, 60_000);

  it("verify refuses an export that is not the recorded import (a later import that did not finish)", async () => {
    const p = tempProject({ prefer: "command" });
    canvas(p);
    const client = await serverFor(p.dir, comparing());
    expect((await call(client, "design_ui_import", { design: "canvas/calendar-empty-day.dc.html" })).isError).toBeFalsy();
    // the other artboard's import exports, then its Unity step fails: the record still names the first page
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: ["sh", "-c", "exit 3"], capture: ["sh", STUB_RUNNER, "--log", p.runnerLog, "capture", "{exportDir}", "{outDir}"], kitSync: [] } } });
    const failing = await serverFor(p.dir, comparing());
    expect((await call(failing, "design_ui_import", { design: "canvas/calendar-month.dc.html" })).isError).toBe(true);
    for (const screen of ["canvas/calendar-empty-day.dc.html", "canvas", "calendar"]) {
      const r = await call(failing, "design_ui_verify", { screen });
      expect(r.isError, screen).toBe(true);
      expect(r.text, screen).toMatch(/the export holds canvas\/calendar-month\.dc\.html; import canvas\/calendar-empty-day\.dc\.html again first/);
      expect(r.data.verdict).toBeNull();
    }
    expect(p.runnerCalls().map((c) => c.split("|")[0])).toEqual(["import"]);
  });

  it("a folder holds one screen: pages that name different screens are an error for import, list, status and verify", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "mixed");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.dc.html"), html);
    fs.writeFileSync(path.join(dir, "b.dc.html"), html.replace('data-u-screen="calendar"', 'data-u-screen="inbox"'));
    const pipeline = stubPipeline();
    const client = await serverFor(p.dir, pipeline);
    const listing = /pages of mixed name different screens \(a\.dc\.html → calendar, b\.dc\.html → inbox\)/;
    const imp = await call(client, "design_ui_import", { design: "mixed/a.dc.html" });
    expect(imp.isError).toBe(true);
    expect(imp.text).toMatch(listing);
    expect(pipeline.exports).toEqual([]);
    expect(p.runnerCalls()).toEqual([]);
    const list = await call(client, "design_ui_list");
    expect(list.data.screens).toEqual([expect.objectContaining({ folder: "mixed", problem: expect.stringMatching(listing) })]);
    for (const [tool, arg] of [["design_ui_status", "mixed/b.dc.html"], ["design_ui_status", "mixed"], ["design_ui_verify", "mixed/a.dc.html"]]) {
      const r = await call(client, tool, { screen: arg });
      expect(r.isError, `${tool} ${arg}`).toBe(true);
      expect(r.text, `${tool} ${arg}`).toMatch(listing);
    }
  });

  it("import refuses a page whose exported screen differs from the screen its folder's other pages name", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = canvas(p);
    // a page whose markup names no screen (a script builds it); its export says "inbox"
    fs.writeFileSync(path.join(dir, "scripted.html"), "<!doctype html><html><body><div id=root></div></body></html>");
    const pipeline = stubPipeline();
    const exportScreen = pipeline.exportScreen!;
    pipeline.exportScreen = async (entry, kit, outDir, browser) => {
      const out = await exportScreen(entry, kit, outDir, browser);
      if (entry.endsWith("scripted.html")) fs.writeFileSync(path.join(outDir, "screen.ir.json"), JSON.stringify({ irVersion: 2, screen: "inbox", source: { path: "scripted.html" } }));
      return out;
    };
    const r = await call(await serverFor(p.dir, pipeline), "design_ui_import", { design: "canvas/scripted.html" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pages of canvas name different screens \(calendar-empty-day\.dc\.html → calendar, calendar-month\.dc\.html → calendar, scripted\.html → inbox\)/);
    expect(p.runnerCalls()).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".design-ui", "last-import.json"))).toBe(false);
  });

  it("a screen id held by two folders is ambiguous; a page path whose file lies outside its folder, or a .zip, is refused", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = canvas(p);
    fs.mkdirSync(path.join(p.designRoot, "copy"));
    fs.copyFileSync(path.join(dir, "calendar-month.dc.html"), path.join(p.designRoot, "copy", "calendar-month.dc.html"));
    const client = await serverFor(p.dir, stubPipeline());
    const ambiguous = await call(client, "design_ui_status", { screen: "calendar" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/screen calendar is in several folders under designRoot: canvas, copy/);
    const list = await call(client, "design_ui_list");
    for (const s of list.data.screens) expect(s.problem, s.folder).toMatch(/screen calendar is also in/);

    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "elsewhere.dc.html"), html);
    fs.symlinkSync(path.join(outside, "elsewhere.dc.html"), path.join(dir, "linked.dc.html"));
    const linked = await call(client, "design_ui_import", { design: "canvas/linked.dc.html" });
    expect(linked.isError).toBe(true);
    expect(linked.text).toMatch(/linked\.dc\.html is a link to a file outside canvas/);

    writeZip(path.join(dir, "design.zip"), [{ name: "screen.html", data: html }]);
    for (const [tool, key] of [["design_ui_import", "design"], ["design_ui_verify", "screen"], ["design_ui_status", "screen"]]) {
      const r = await call(client, tool, { [key]: "canvas/design.zip" });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/not a design page/);
    }
  });

  it("records a page by its name on disk when the path differs only in letter case (case-insensitive file systems)", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = canvas(p);
    if (!fs.existsSync(path.join(dir, "Calendar-Month.dc.html"))) return; // a case-sensitive file system has no such file
    const client = await serverFor(p.dir, stubPipeline());
    const r = await call(client, "design_ui_import", { design: "canvas/Calendar-Month.dc.html" });
    expect(r.isError, r.text).toBeFalsy();
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8")).entry).toBe("calendar-month.dc.html");
    expect((await call(client, "design_ui_status", { screen: "canvas/CALENDAR-MONTH.dc.html" })).data).toMatchObject({ entry: "calendar-month.dc.html", state: "imported" });
  });

  it("runs the real export of the artboard it is given: the IR's screen is that page's data-u-screen", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = path.join(p.designRoot, "canvas");
    const src = path.resolve(here, "../../design-export/test/fixtures/export/inbox-mini");
    fs.cpSync(src, dir, { recursive: true });
    // two artboards of the screen "inbox-b" (the folder is named otherwise)
    const page = fs.readFileSync(path.join(dir, "inbox-mini.html"), "utf8").replace('data-u-screen="inbox-mini"', 'data-u-screen="inbox-b"');
    fs.rmSync(path.join(dir, "inbox-mini.html"));
    fs.writeFileSync(path.join(dir, "inbox-a.html"), page);
    fs.writeFileSync(path.join(dir, "inbox-b.html"), page);
    const r = await call(await serverFor(p.dir), "design_ui_import", { design: "canvas/inbox-b.html" });
    expect(r.isError, r.text).toBeFalsy();
    const ir = JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "export", "screen.ir.json"), "utf8"));
    expect(ir.screen).toBe("inbox-b");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8"))).toMatchObject({ screen: "inbox-b", entry: "inbox-b.html" });
  }, 120_000);
});

describe("version drift between this server and the Unity package", () => {
  it("refuses an import before Unity when the package's major version or its IR version differs; warns on a minor drift", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    const client = await serverFor(p.dir, stubPipeline());

    bridge.statusVersion = "1.0.0"; bridge.statusIrVersion = 2;
    const major = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(major.isError).toBe(true);
    expect(major.text).toMatch(/^Import of clean\.screen not run: the Unity package com\.ertugrulgaziakcan\.design-ui is 1\.0\.0, this MCP server 0\.1\.0/);
    expect(bridge.requests.some((q) => q.path === "/import")).toBe(false);

    // a package of the same version that reads IR version 1 (built before the text field's rename) would read every text
    // of this server's exports as empty: refused, both IR versions named, nothing exported
    bridge.statusVersion = "0.1.0"; bridge.statusIrVersion = 1;
    const older = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(older.isError).toBe(true);
    expect(older.text).toMatch(/reads IR version 1, the exporter writes IR version 2: update the package/);
    expect(older.data).toMatchObject({ exported: false, unityCalled: false });
    bridge.statusIrVersion = 3;
    const ir = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(ir.isError).toBe(true);
    expect(ir.text).toMatch(/reads IR version 3, the exporter writes IR version 2: update the unity-ui-mcp clone/);
    expect(bridge.requests.some((q) => q.path === "/import")).toBe(false);

    bridge.statusVersion = "0.2.0"; bridge.statusIrVersion = 2;
    const minor = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(minor.isError, minor.text).toBeFalsy();
    expect(minor.text).toMatch(/Warning: the Unity package com\.ertugrulgaziakcan\.design-ui is 0\.2\.0, this MCP server 0\.1\.0/);
    expect(bridge.requests.some((q) => q.path === "/import")).toBe(true);
    expect((await call(client, "design_ui_status")).text).toMatch(/package version: 0\.2\.0, reads IR version 2 \(server 0\.1\.0, writes IR version 2\): minor drift/);
  });

  it("says nothing when the versions match, or when an older bridge does not report them", async () => {
    const p = tempProject({ prefer: "editor" });
    p.addScreen("clean-screen", "clean-screen");
    bridge = await startStubBridge(p.dir);
    const client = await serverFor(p.dir, stubPipeline());
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).not.toMatch(/Warning: the Unity package/);
    bridge.statusVersion = "0.1.0"; bridge.statusIrVersion = 2;
    const s = await call(client, "design_ui_status");
    expect(s.text).toMatch(/package version: 0\.1\.0, reads IR version 2 \(server 0\.1\.0, writes IR version 2\): matches/);
    expect(s.data).toMatchObject({ irVersion: 2, unity: { irVersion: 2 }, versionDrift: { level: "ok" } });
  });

  it("status names the IR version the package reads and the one the exporter writes", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.statusVersion = "0.1.0"; bridge.statusIrVersion = 1;
    const s = await call(await serverFor(p.dir, stubPipeline()), "design_ui_status");
    expect(s.text).toContain("package version: 0.1.0, reads IR version 1 (server 0.1.0, writes IR version 2): imports refused: " +
      "the Unity package com.ertugrulgaziakcan.design-ui reads IR version 1, the exporter writes IR version 2: update the package");
    expect(s.data).toMatchObject({ irVersion: 2, unity: { irVersion: 1 }, versionDrift: { level: "error" } });
  });
});

describe("design_ui_kit_sync", () => {
  it("never writes into the unity-ui-mcp clone's own design-kit: it says how to move the kit, and status warns", async () => {
    const p = tempProject({ prefer: "editor" });
    const cloneKit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit");
    p.writeConfig({ kitDir: cloneKit });
    bridge = await startStubBridge(p.dir);
    const client = await serverFor(p.dir);
    const r = await call(client, "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`kitDir is the unity-ui-mcp clone's own design-kit (${cloneKit})`);
    expect(r.text).toContain(path.join(p.designRoot, "design-kit"));
    expect(bridge.requests.some((q) => q.path === "/kit-sync")).toBe(false);
    expect((await call(client, "design_ui_status")).text).toContain("warning: kitDir is the unity-ui-mcp clone's own design-kit");
  });

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

  /** A kit sync log whose font twin list alone is longer than the log tail. */
  const longLog = (head: string) =>
    `${head}\nwarning: two TMP Settings assets\nfont twins: ${Array.from({ length: 200 }, (_, i) => `Assets/UI/Fonts/Font ${i} UITK r125s16.asset`).join(", ")}`;
  const summary = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it("shows Unity's warnings first and the log tail last, however long the log", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = { code: 0, log: longLog("Kit synced into /kit: 30 files, 0 written."), warnings: ["two TMP Settings assets", "label under 10 device px"], errors: [] };
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ warnings: ["two TMP Settings assets", "label under 10 device px"], errors: [] });
    expect(summary(r)).toMatch(/^Kit synced into .* via editor\.\nUnity warnings \(2\):\n- two TMP Settings assets\n- label under 10 device px\nLog tail:\n…/);
    expect(summary(r).length).toBeLessThan(4300);
  });

  it("a failed kit sync shows Unity's errors first", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = { code: 1, log: longLog("Kit sync failed; nothing was written."), warnings: ["two TMP Settings assets"], errors: ["Font not resolvable: no font resolves for locale 'ja'"] };
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(summary(r)).toMatch(/^Kit sync failed \(exit 1, via editor\)\.\nUnity errors \(1\):\n- Font not resolvable: no font resolves for locale 'ja'\nUnity warnings \(1\):\n- two TMP Settings assets\nLog tail:\n/);
    // an older bridge answers without the lists: the log tail alone, as before
    bridge.answer = { code: 1, log: "Kit sync failed; nothing was written.\nerror: x" };
    const old = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(old.data).toMatchObject({ warnings: [], errors: [] });
    expect(summary(old)).toBe("Kit sync failed (exit 1, via editor).\nLog tail:\nKit sync failed; nothing was written.\nerror: x");
  });

  it("reports progress while Unity works, to a client that asks for it, and waits past 300 s", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const hold = bridge.holdPosts();
    const clock = manualClock();
    const client = await connect(createServer(readConfig(p.dir), { runtime, runnerOptions: { ...fast, clock, progressEveryMs: 10_000 } }));
    const seen: { progress: number; message?: string }[] = [];
    const pending = client.callTool({ name: "design_ui_kit_sync", arguments: {} }, undefined, { onprogress: (x) => seen.push(x), resetTimeoutOnProgress: true });
    await hold.arrived;
    clock.advance(310_000);
    await new Promise((r) => setTimeout(r, 50)); // the notifications cross the in-memory transport
    hold.release();
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(seen.map((x) => x.progress)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(seen[30].message).toBe("Unity kit sync: running, 310 s");
  });

  it("a kit that declares viewports the profile lacks: the refusal comes first with how to add them; addProfileViewports asks Unity to add them", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const refusal = "kit viewports missing from the profile: kit.config.json declares 3840×2160 (exact), 1600×900 (scaled), 1366×768 (scaled), which the DesignUiProfile lacks; kit sync would drop them";
    bridge.answer = { code: 1, log: `Kit sync failed; nothing was written into /kit and no font twin was changed.\nerror: ${refusal}`, warnings: [], errors: [refusal] };
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(summary(r)).toMatch(/^Kit sync failed \(exit 1, via editor\)\.\nUnity errors \(1\):\n- kit viewports missing from the profile: /);
    expect(summary(r)).toContain("design_ui_kit_sync with addProfileViewports: true");
    expect(summary(r)).toContain("Window > Design UI > Add Default Viewports to Profile");
    expect(bridge.requests.filter((q) => q.path === "/kit-sync").map((q) => (q.body as { addProfileViewports?: boolean }).addProfileViewports)).toEqual([false]);

    bridge.answer = { code: 0, log: "Kit synced into /kit: 30 files, 1 written.\nnote: added to the DesignUiProfile: 3840×2160 (exact), 1600×900 (scaled), 1366×768 (scaled)", warnings: [], errors: [] };
    const added = await call(await serverFor(p.dir), "design_ui_kit_sync", { addProfileViewports: true });
    expect(added.isError).toBeFalsy();
    expect(bridge.requests.filter((q) => q.path === "/kit-sync").map((q) => (q.body as { addProfileViewports?: boolean }).addProfileViewports)).toEqual([false, true]);
    expect(summary(added)).not.toContain("addProfileViewports: true");
  });

  it("succeeds through the command route", async () => {
    const p = tempProject({ prefer: "command" });
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBeFalsy();
    expect(p.runnerCalls()[0]).toMatch(/^kitSync\|/);
  });

  it("through the command route counts only a kit sync Unity confirms in its done marker (an exit code alone proves nothing)", async () => {
    const p = tempProject({ prefer: "command", kitSyncDone: "none" });
    const r = await call(await serverFor(p.dir), "design_ui_kit_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Kit sync \(via command\) exited 0 but did not confirm it: no kit-sync done marker/);
    expect(r.text).toContain("DesignUiOpsTests.KitSyncFromEnv or DesignUiBatch.KitSync");
  });
});

describe("design_ui_verify", () => {
  it("does not capture when the configuration cannot run the Unity capture", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    p.writeConfig({ unityRunner: { prefer: "command", captureVia: "editor" } });
    const r = await call(await serverFor(p.dir, { ...stubPipeline(), compareScreen: INSTALLED_PIPELINE.compareScreen, unityCapture: true }), "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot capture: the com\.ertugrulgaziakcan\.design-ui package has no Editor capture/);
    expect(r.data).toMatchObject({ available: false, missing: ["capture"], verdict: null });
    expect(p.runnerCalls()).toEqual([]);
  });

  it("gives no verdict for a capture that exits 0 without its done marker, and never compares it", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", "mkdir -p \"$0\"", "{outDir}"], kitSync: [] } } });
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

  /** Evidence folders a failed verify kept: `<screen>/.design-ui/failed-<run>`. */
  const failedRuns = (dir: string) => fs.readdirSync(path.join(dir, ".design-ui")).filter((n) => n.startsWith("failed-")).sort();

  it("keeps a failed capture's partial captures and its log in a failed-<run> folder next to the result, and says where", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const partial = 'mkdir -p "$0" && printf png > "$0/default@320x180.png" && printf "{}" > "$0/boxes.meta.json" && echo "capture line 1" && echo "capture failed: timeout" >&2 && exit 3';
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", partial, "{outDir}"], kitSync: [] } } });
    const client = await serverFor(p.dir, { ...stubPipeline(), unityCapture: true, compareScreen: async () => ({ pass: true, topIssues: [], notRun: [], compared: 1 }) });
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.data.verdict).toBeNull();
    const runs = failedRuns(dir);
    expect(runs).toHaveLength(1);
    const kept = path.join(dir, ".design-ui", runs[0]);
    expect(r.data.evidence).toBe(kept);
    expect(r.text).toContain(`Partial captures and logs kept in ${kept}`);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity.next"))).toBe(false);
    expect(fs.readFileSync(path.join(kept, "default@320x180.png"), "utf8")).toBe("png");
    expect(fs.existsSync(path.join(kept, "boxes.meta.json"))).toBe(true);
    const log = fs.readFileSync(path.join(kept, "unity.log"), "utf8");
    expect(log).toContain("capture line 1");
    expect(log).toContain("capture failed: timeout");
    expect(JSON.parse(fs.readFileSync(path.join(kept, "failure.json"), "utf8"))).toMatchObject({ screen: "clean.screen", code: 3, via: "command", reason: expect.stringContaining("exit 3") });
  });

  it("keeps the evidence of a capture without a done marker and of a timed-out capture; only the newest three failed runs stay", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const unfinished = 'mkdir -p "$0" && printf png > "$0/default@320x180.png" && echo "stopped early"';
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", unfinished, "{outDir}"], kitSync: [] } } });
    const pipeline = { ...stubPipeline(), unityCapture: true, compareScreen: async () => ({ pass: true, topIssues: [], notRun: [], compared: 1 }) };
    let client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.text).toMatch(/did not finish \(no capture-done\.json\); no verdict/);
    expect(fs.readFileSync(path.join(r.data.evidence, "unity.log"), "utf8")).toContain("stopped early");

    // the runner stops the command at the limit; a child that keeps its output open is cut off after a short grace
    const slow = 'mkdir -p "$0" && printf png > "$0/default@320x180.png" && echo "still capturing" && sleep 30';
    p.writeConfig({ unityRunner: { prefer: "command", timeoutSec: 1, command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", slow, "{outDir}"], kitSync: [] } } });
    client = await serverFor(p.dir, pipeline);
    const t = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(t.text).toMatch(/did not finish within 1 s/);
    expect(t.data.evidence).toMatch(/failed-/);
    expect(fs.readFileSync(path.join(t.data.evidence, "default@320x180.png"), "utf8")).toBe("png");
    expect(fs.readFileSync(path.join(t.data.evidence, "unity.log"), "utf8")).toContain("still capturing");
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", unfinished, "{outDir}"], kitSync: [] } } });
    client = await serverFor(p.dir, pipeline);
    for (let i = 0; i < 3; i++) await call(client, "design_ui_verify", { screen: "clean-screen" });
    const runs = failedRuns(dir);
    expect(runs).toHaveLength(3);
    expect(runs).not.toContain(path.basename(r.data.evidence));
  }, 30_000);

  it("keeps the evidence when the comparison itself fails (an unreadable boxes.json), with no verdict", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const bad = 'mkdir -p "$0" && printf png > "$0/default@320x180.png" && printf "{not json" > "$0/boxes.json" && echo "{}" > "$0/capture-done.json"';
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: CONFIRMING_IMPORT, capture: ["sh", "-c", bad, "{outDir}"], kitSync: [] } } });
    const pipeline = { ...stubPipeline(), unityCapture: true, compareScreen: async () => { throw new Error("boxes.json is not JSON"); } };
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Comparison of clean\.screen failed: boxes\.json is not JSON; no verdict\. Partial captures and logs kept in .*failed-/);
    expect(fs.readFileSync(path.join(r.data.evidence, "boxes.json"), "utf8")).toBe("{not json");
    expect(r.data.verdict).toBeNull();
  });

  it("keeps the evidence of a failed verify when its captures cannot be moved (a locked file): copied, or named in failure.json", () => {
    const bookkeeping = tempDir(), staging = path.join(bookkeeping, "unity.next");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "default@320x180.png"), "png");
    const info = { screen: "s", entry: null, reason: "Unity capture did not finish", code: 1, via: "command", log: "the log", timings: {} };
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); });
    try {
      const dir = keepFailedRun(bookkeeping, staging, info);
      expect(fs.readFileSync(path.join(dir, "default@320x180.png"), "utf8")).toBe("png");
      expect(fs.readFileSync(path.join(dir, "unity.log"), "utf8")).toBe("the log");
      const cp = vi.spyOn(fs, "cpSync").mockImplementation(() => { throw new Error("EPERM: operation not permitted"); });
      try {
        const bare = keepFailedRun(bookkeeping, staging, info);
        expect(JSON.parse(fs.readFileSync(path.join(bare, "failure.json"), "utf8")).evidence).toMatch(/could not be moved.*EBUSY.*EPERM/);
        expect(fs.readFileSync(path.join(bare, "unity.log"), "utf8")).toBe("the log");
      } finally { cp.mockRestore(); }
    } finally { rename.mockRestore(); }
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

  it("runs one import or verify per screen folder: a call that overlaps a running one is refused and touches nothing", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = { ...stubPipeline(), unityCapture: true };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), started = new Promise<void>((r) => { entered = r; });
    let compares = 0;
    pipeline.compareScreen = async (_e, unityDir, reportFile) => {
      compares++;
      entered();
      await gate;
      // the first run's staging folder is still its own: the second call deleted nothing
      expect(fs.existsSync(unityDir)).toBe(true);
      fs.writeFileSync(reportFile, "<p>report</p>");
      return { pass: true, topIssues: [], notRun: [] };
    };
    const client = await serverFor(p.dir, pipeline);
    await call(client, "design_ui_import", { design: "clean-screen" });
    const calls = p.runnerCalls().length;
    // what a cleanup would remove (another screen's finished captures): a refused call runs no cleanup either
    const other = p.addScreen("other-screen", "clean-screen");
    fs.mkdirSync(path.join(other, ".design-ui", "unity"), { recursive: true });
    const first = call(client, "design_ui_verify", { screen: "clean-screen" });
    await started;
    for (const [tool, args] of [["design_ui_verify", { screen: "clean-screen" }], ["design_ui_import", { design: "clean-screen" }]] as const) {
      const second = await call(client, tool, args);
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/^An import or verify of clean-screen is running; call it again when it ends\./);
      expect(second.data).toMatchObject({ screen: "clean-screen", running: { what: "verify" } });
      expect(second.data.cleanup).toBeUndefined();
    }
    expect(fs.existsSync(path.join(other, ".design-ui", "unity"))).toBe(true);
    // neither refused call ran Unity
    expect(p.runnerCalls()).toHaveLength(calls + 1);
    release();
    const r = await first;
    expect(r.data).toMatchObject({ verdict: "pass" });
    expect(compares).toBe(1);
    // once the first ends, the next call runs
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).isError).toBeFalsy();
    expect(fs.existsSync(path.join(dir, ".design-ui", "busy.json"))).toBe(false);
  });

  it("calls a screen whose design hides a job in every context incomplete, never a pass, at import and at verify", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const pipeline = { ...stubPipeline(), unityCapture: true };
    const exportScreen = pipeline.exportScreen!;
    pipeline.exportScreen = async (...a) => ({ ...(await exportScreen(...a)), hidden: [{ name: "default@64x48.hover.ghost", reason: "ghost not visible" }] });
    pipeline.compareScreen = async (_e, _u, reportFile) => {
      fs.writeFileSync(reportFile, "<p>report</p>");
      return { pass: false, status: "incomplete", hidden: ["default@64x48.hover.ghost"], topIssues: [], notRun: [] };
    };
    const client = await serverFor(p.dir, pipeline);
    const imp = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(imp.isError).toBeFalsy();
    expect(imp.text).toContain("Hidden in the design (no golden, so a verify is incomplete");
    expect(imp.data.hidden).toEqual(["default@64x48.hover.ghost"]);
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^INCOMPLETE: clean.screen /);
    expect(r.text).toContain("Hidden in the design (no golden, not compared");
    expect(r.data).toMatchObject({ verdict: "incomplete", hidden: ["default@64x48.hover.ghost"] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8"))).toMatchObject({ verdict: "incomplete", hidden: ["default@64x48.hover.ghost"] });
    expect(screenStatus(readConfig(p.dir), "clean-screen")).toMatchObject({ state: "incomplete", verdict: "incomplete" });
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
      fs.writeFileSync(path.join(outDir, "screen.ir.json"), JSON.stringify({ irVersion: 2, screen: "clean-screen", root: { id: "root", children: [{ id: "card", children: [] }] } }));
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
      import: CONFIRMING_IMPORT,
      capture: ["sh", "-c", `mkdir -p "$1" && cp "$0"/goldens/*.png "$0"/goldens/boxes.json "$1"/ && echo '{"runId":"t","jobs":2,"captured":2,"notCaptured":0}' > "$1"/capture-done.json && rm -f ${without.map((f) => `"$1/${f}"`).join(" ") || '"$1/none"'}`, "{exportDir}", "{outDir}"],
      kitSync: ["sh", "-c", "exit 0"],
    },
  },
});

/** copyCapture whose Unity also writes a boxes.meta.json with this colour space and colour path. */
const colourCapture = (colorSpace: string, colorPath: string) => {
  const c = copyCapture();
  const meta = JSON.stringify({ status: "complete", notCaptured: [], unity: { colorSpace, colorPath } });
  c.unityRunner.command.capture[2] = `${c.unityRunner.command.capture[2]} && echo '${meta}' > "$1"/boxes.meta.json`;
  return c;
};

describe("design_ui_verify with the installed comparison", () => {
  it("names the colour path of a Linear project: a note for the gamma composite, a warning for a linear on-screen panel", async () => {
    for (const [colorPath, line] of [
      ["gamma-composite", /\nColour: Linear colour space, captured through the gamma composite: in game this holds for panels rendered through DesignUiGammaComposite/],
      ["linear-panel", /\nWarning: Linear colour space, colour path Linear Panel: Unity blends translucent colours in linear light/],
    ] as const) {
      const p = tempProject({ prefer: "command" });
      p.writeConfig(colourCapture("Linear", colorPath));
      p.addScreen("clean-screen", "clean-screen");
      const client = await serverFor(p.dir, goldenPipeline());
      expect((await call(client, "design_ui_import", { design: "clean-screen" })).isError).toBeFalsy();
      const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
      expect(r.text).toMatch(/^PASS: clean-screen/);
      expect(r.text).toMatch(line);
      expect(r.data.colour).toEqual({ space: "Linear", path: colorPath });
    }
  });

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
    // the captures per viewport class (this export declares no scaled viewport: all exact)
    expect(r.text).toMatch(/^Viewports exact 64×48: 2 pass, 0 fail$/m);
    expect(r.data.byClass).toEqual({ exact: { viewports: [[64, 48]], pass: 2, fail: 0, notRun: 0 } });
    // lint from the exporter's report; export, import and capture as this server measured them
    expect(r.data.steps).toMatchObject({ lint: 11 });
    expect(typeof r.data.steps.export).toBe("number");
    expect(r.data.steps.capture).toBeGreaterThanOrEqual(0);
    expect(r.data.steps).toHaveProperty("import");
    const html = fs.readFileSync(path.join(dir, "report.html"), "utf8");
    expect(html).toContain("default@64x48");
    expect(html).toContain("PASS");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "compare", "verdict.json"), "utf8"))).toMatchObject({ pass: true });
    // published: the report keeps no pictures of passing captures, and the run's captures and difference images are gone
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, ".design-ui", "compare"))).toEqual(["verdict.json"]);
    expect(fs.existsSync(path.join(dir, ".design-ui", "report"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity.next"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".design-ui", "compare.next"))).toBe(false);
    expect(html).not.toContain(".design-ui/unity");
    expect(html).toContain("Passed: its pictures are not kept");
    expect(screenStatus(readConfig(p.dir), "clean-screen")).toMatchObject({ state: "verified", verdict: "pass" });
    // the report and the bookkeeping do not change the design's source hash
    expect(screenStatus(readConfig(p.dir), "clean-screen").sourceSha).toBe(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-import.json"), "utf8")).sourceSha);
  });

  it("keeps the run's Unity captures on request (keepCaptures): in the bookkeeping, counted by the budget, removed by design_ui_clean and the next verify", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig(copyCapture());
    const dir = p.addScreen("clean-screen", "clean-screen");
    const kept = path.join(dir, ".design-ui", "kept-captures");
    const client = await serverFor(p.dir, goldenPipeline());
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).isError).toBeFalsy();
    const r = await call(client, "design_ui_verify", { screen: "clean-screen", keepCaptures: true });
    expect(r.text).toMatch(/^PASS: clean-screen/);
    // the whole capture folder, so the comparison can run again offline (design-export compare <export> --unity <kept>)
    expect(fs.readdirSync(kept).sort()).toEqual(["boxes.json", "capture-done.json", "default@64x48.png", "hover@64x48.png"]);
    expect(r.data.keptCaptures).toEqual({ dir: kept, bytes: expect.any(Number) });
    expect(r.text).toContain(`Unity captures kept in ${kept}`);
    expect(r.text).toMatch(/design-export compare .*--unity/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8")).keptCaptures).toBe(kept);
    // the report says where they are, not that they were deleted
    expect(fs.readFileSync(path.join(dir, "report.html"), "utf8")).toContain("kept on request");
    // the automatic cleanup after the run left them (within the budget); the budget counts them
    expect(r.data.cleanup).toBeUndefined();
    const status = await call(client, "design_ui_clean", { screen: "clean-screen", dryRun: true });
    expect(status.text).toContain(".design-ui/kept-captures");
    expect(status.data.before).toBeGreaterThanOrEqual(r.data.keptCaptures.bytes);

    // the next verify removes them (and keeps none of its own unless asked)
    expect((await call(client, "design_ui_verify", { screen: "clean-screen" })).text).toMatch(/^PASS/);
    expect(fs.existsSync(kept)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8")).keptCaptures).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "report.html"), "utf8")).not.toContain("kept on request");

    // design_ui_clean removes them
    expect((await call(client, "design_ui_verify", { screen: "clean-screen", keepCaptures: true })).data.keptCaptures.dir).toBe(kept);
    const clean = await call(client, "design_ui_clean", { screen: "clean-screen" });
    expect(clean.isError).toBeFalsy();
    expect(clean.text).toContain(".design-ui/kept-captures");
    expect(fs.existsSync(kept)).toBe(false);
  });

  it("never removes the captures a verify kept in its own cleanup, even over the budget; a later cleanup that does says so (review finding 3)", async () => {
    const p = tempProject({ prefer: "command" });
    // a budget the bookkeeping is over as soon as it holds an export
    p.writeConfig({ ...copyCapture(), cacheBudgetMB: 0.001 });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const kept = path.join(dir, ".design-ui", "kept-captures");
    const client = await serverFor(p.dir, goldenPipeline());
    await call(client, "design_ui_import", { design: "clean-screen" });
    const r = await call(client, "design_ui_verify", { screen: "clean-screen", keepCaptures: true });
    expect(r.text).toContain(`Unity captures kept in ${kept}`);
    expect(fs.existsSync(kept)).toBe(true);
    expect(String(r.data.cleanup ?? "")).not.toContain("kept-captures");
    // nor the export the offline comparison the answer prints needs (re-review N4)
    expect(fs.existsSync(path.join(dir, ".design-ui", "export", "goldens", "boxes.json"))).toBe(true);
    expect(String(r.data.cleanup ?? "")).not.toContain(".design-ui/export");
    // the next cleanup may remove them: the record and the report stop naming them
    const clean = await call(client, "design_ui_clean", { screen: "clean-screen" });
    expect(clean.text).toContain(".design-ui/kept-captures");
    expect(fs.existsSync(kept)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8")).keptCaptures).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "report.html"), "utf8")).toContain("Kept captures removed");
  });

  it("drops the captures a verify kept when an import exports the screen again (review finding 8)", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig(copyCapture());
    const dir = p.addScreen("clean-screen", "clean-screen");
    const kept = path.join(dir, ".design-ui", "kept-captures");
    const client = await serverFor(p.dir, goldenPipeline());
    await call(client, "design_ui_import", { design: "clean-screen" });
    await call(client, "design_ui_verify", { screen: "clean-screen", keepCaptures: true });
    expect(fs.existsSync(kept)).toBe(true);
    // this pipeline's export always writes the export again
    const r = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(r.text).toContain("The Unity captures a verify kept were removed");
    expect(r.data.keptCapturesRemoved).toBe(true);
    expect(fs.existsSync(kept)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8")).keptCaptures).toBeUndefined();
  });

  it("never verifies an export another version of the exporter made: no capture and no verdict, import the screen again", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig(copyCapture());
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, goldenPipeline());
    await call(client, "design_ui_import", { design: "clean-screen" });
    const report = path.join(dir, ".design-ui", "export", "export-report.json");
    const ok = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(ok.text).not.toMatch(/another version of the exporter/);
    const record = fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8");
    const captures = p.runnerCalls().filter((c) => c.startsWith("capture|")).length;
    // goldens of an older extraction may lack what this comparison reads: a verdict on them could pass what it cannot see
    fs.writeFileSync(report, JSON.stringify({ ...JSON.parse(fs.readFileSync(report, "utf8")), toolSha: "0".repeat(64) }));
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.isError).toBe(true);
    expect(r.data.verdict).toBeNull();
    expect(r.text).toMatch(/^clean-screen cannot be verified: its export was made by another version of the exporter/);
    expect(r.text).toMatch(/Run design_ui_import \{ design: "clean-screen\/screen.html" \} \(it exports the screen again\)/);
    expect(p.runnerCalls().filter((c) => c.startsWith("capture|"))).toHaveLength(captures);
    expect(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json"), "utf8")).toBe(record);
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
    // the earlier report and verdict stay exactly as they were
    expect(fs.readFileSync(path.join(dir, "report.html")).equals(report)).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".design-ui", "last-verify.json")).equals(lastVerify)).toBe(true);
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

describe("design_ui_verify keeps what its report shows and nothing else", () => {
  it("a failing capture keeps its thumbnails next to the report; the run's captures and difference images go", async () => {
    const p = tempProject({ prefer: "command" });
    // Unity draws the default capture in another colour: the capture fails
    p.writeConfig({
      unityRunner: {
        prefer: "command",
        command: {
          import: CONFIRMING_IMPORT,
          capture: ["sh", "-c", `mkdir -p "$1" && cp "$0"/goldens/*.png "$0"/goldens/boxes.json "$1"/ && cp "$2" "$1"/default@64x48.png && echo '{"runId":"t","jobs":2,"captured":2,"notCaptured":0}' > "$1"/capture-done.json`,
            "{exportDir}", "{outDir}", path.join(FIXTURES, "red-64x48.png")],
          kitSync: ["sh", "-c", "exit 0"],
        },
      },
    });
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, goldenPipeline());
    expect((await call(client, "design_ui_import", { design: "clean-screen" })).isError).toBeFalsy();
    const r = await call(client, "design_ui_verify", { screen: "clean-screen" });
    expect(r.data.verdict).toBe("fail");
    const pics = fs.readdirSync(path.join(dir, ".design-ui", "report")).sort();
    expect(pics).toEqual(expect.arrayContaining(["0-design.png", "0-unity.png"]));
    // a whole-capture issue has no place: no crop (crops are tested with the exporter's report)
    const html = fs.readFileSync(path.join(dir, "report.html"), "utf8");
    // every picture the report shows exists, and none of them is a Unity capture of the run
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(fs.existsSync(path.join(dir, s)), s).toBe(true);
    expect(srcs.every((s) => s.startsWith(".design-ui/report/"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".design-ui", "unity"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, ".design-ui", "compare"))).toEqual(["verdict.json"]);
    // the next verify replaces the previous one's output: no picture, verdict or difference image of the earlier run stays
    fs.writeFileSync(path.join(dir, ".design-ui", "report", "99-design.png"), "an older run's picture");
    fs.writeFileSync(path.join(dir, ".design-ui", "compare", "old-diff.png"), "an older run's difference image");
    expect((await call(client, "design_ui_verify", { screen: "clean-screen" })).data.verdict).toBe("fail");
    expect(fs.readdirSync(path.join(dir, ".design-ui", "report")).sort()).toEqual(pics);
    expect(fs.readdirSync(path.join(dir, ".design-ui", "compare"))).toEqual(["verdict.json"]);
  });
});

describe("without design-ui.config.json", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(createUnconfiguredServer(tempDir(), "design-ui.config.json not found", { runtime }));
  });

  it("still lists the 9 tools and serves the rules", async () => {
    expect((await client.listTools()).tools).toHaveLength(9);
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

describe("viewport classes", () => {
  it("names the kit's viewports by class, exact first", () => {
    expect(kitViewports({ viewports: [[2560, 1440], [1366, 768], [1280, 720]], scaledViewports: [[1366, 768]] })).toBe("exact 2560×1440, 1280×720; scaled 1366×768");
    expect(kitViewports({ viewports: [[2560, 1440]] })).toBe("exact 2560×1440");
  });
});

describe("screen contract wiring and status", () => {
  const EXAMPLE = {
    contract: 1, screen: "club.overview", kind: "update",
    replaces: "The current club overview screen (its route, view and presenter as the project names them)",
    values: [
      { name: "club-name", source: "the club service's current club name", samples: ["Northbridge FC"], origin: "existing" },
      { name: "player-name", repeat: "player", source: "squad reader, player display name", samples: ["A. Novak"], origin: "existing" },
      { name: "budget", source: "finance reader, formatted in the display currency", samples: ["€12.4M"], origin: "existing" },
    ],
    actions: [
      { name: "open-inbox", handler: "shell route command: open inbox", origin: "existing" },
      { name: "open-player", repeat: "player", handler: "player profile route with the row's player id", origin: "existing" },
      { name: "compare-players", handler: null, origin: "requested", note: "user, 2026-11-16: add a compare button" },
    ],
    states: [{ name: "loading", when: "first read of the club data has not finished", origin: "existing" }],
    repeats: [{ name: "player", source: "squad reader, first-team players", count: [0, 40], origin: "existing" }],
    texts: [{ key: "club.overview.title", en: "Club overview", origin: "existing" }],
    removed: [],
  };
  const write = (dir: string) => fs.writeFileSync(path.join(dir, "screen.contract.json"), JSON.stringify(EXAMPLE));

  it("wiringOf lists every value, action, state and repeat but no text, and the requested ones without a source", () => {
    const parsed = parseScreenContract(EXAMPLE);
    if (!("contract" in parsed)) throw new Error(parsed.problems.join("\n"));
    const w = wiringOf(parsed.contract);
    expect(w.entries).toHaveLength(8);
    expect(w.entries.some((e) => e.kind === "text")).toBe(false);
    expect(w.entries).toContainEqual({ kind: "repeat", name: "player", in: "screen", source: "squad reader, first-team players", count: [0, 40] });
    expect(w.entries).toContainEqual({ kind: "value", name: "player-name", in: "player", source: "squad reader, player display name" });
    expect(w.dependencies).toEqual([{ kind: "action", name: "compare-players", in: "screen", source: null }]);
  });

  it("an import with a contract lists the wiring, also when nothing changed", async () => {
    const p = tempProject({ prefer: "command" });
    const dir = p.addScreen("clean-screen", "clean-screen");
    write(dir);
    const client = await serverFor(p.dir, stubPipeline());
    const first = await call(client, "design_ui_import", { design: "clean-screen" });
    const again = await call(client, "design_ui_import", { design: "clean-screen" });
    expect(again.data).toMatchObject({ unityCalled: false });
    for (const r of [first, again]) {
      expect(r.isError).toBeFalsy();
      expect(r.text).toContain("Wiring checklist (from screen.contract.json): connect the generated view to these, then prove each in Play mode:");
      expect(r.text).toContain("- value club-name (screen) ← the club service's current club name");
      expect(r.text).toContain("- action open-player (player) → player profile route with the row's player id");
      expect(r.text).toContain("- state loading (screen) when first read of the club data has not finished");
      expect(r.text).toContain("- repeat player (screen) ← squad reader, first-team players, count 0–40");
      expect(r.text).toContain("Named dependencies (no source in the game yet): action compare-players");
      expect(r.text).not.toContain("club.overview.title");
      expect(r.data.wiring.contract).toBe("valid");
      expect(r.data.wiring.entries).toHaveLength(8);
      expect(r.data.wiring.dependencies).toHaveLength(1);
    }
  });

  it("an import without a contract says the wiring list comes from the inventory", async () => {
    const p = tempProject({ prefer: "command" });
    p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir, stubPipeline());
    for (let n = 0; n < 2; n++) {
      const r = await call(client, "design_ui_import", { design: "clean-screen" });
      expect(r.text).toContain("No screen contract: the wiring list must come from the inventory (the skill's step 3).");
      expect(r.text).not.toContain("Wiring checklist");
      expect(r.data.wiring).toEqual({ contract: "absent", entries: [], dependencies: [] });
    }
  });

  it("status shows the kit's screenContract setting and each screen's contract state", async () => {
    const p = tempProject();
    const dir = p.addScreen("clean-screen", "clean-screen");
    const client = await serverFor(p.dir);
    const all = await call(client, "design_ui_status");
    expect(all.data.screenContract).toMatch(/^(optional|required)$/);
    expect(all.text).toContain(`screen contract: ${all.data.screenContract}`);
    const none = await call(client, "design_ui_status", { screen: "clean-screen" });
    expect(none.data).toMatchObject({ contract: "absent", contractProblems: 0 });
    expect(none.text).toContain("contract: absent");
    write(dir);
    expect((await call(client, "design_ui_status", { screen: "clean-screen" })).data).toMatchObject({ contract: "valid", contractProblems: 0 });
    fs.writeFileSync(path.join(dir, "screen.contract.json"), JSON.stringify({ contract: 2 }));
    const bad = await call(client, "design_ui_status", { screen: "clean-screen" });
    expect(bad.data.contract).toBe("invalid");
    expect(bad.data.contractProblems).toBeGreaterThan(0);
    expect(bad.text).toMatch(/contract: invalid \(\d+ problems?\)/);
  });
});
