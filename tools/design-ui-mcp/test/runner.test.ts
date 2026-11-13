import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBridge, bridgeStatus } from "../src/bridge.js";
import { readConfig } from "../src/config.js";
import { expandTemplate, runUnity, UnityRunnerError } from "../src/runner.js";
import { startStubBridge, tempProject, type StubBridge } from "./helpers.js";

const fast = { pollIntervalMs: 10, settleMs: 20, compileTimeoutMs: 5000 };
let bridge: StubBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

describe("findBridge", () => {
  it("reads Library/DesignUi/bridge.json for this project", async () => {
    const p = tempProject({ prefer: "editor" });
    expect(findBridge(p.dir)).toBeNull();
    bridge = await startStubBridge(p.dir);
    expect(findBridge(p.dir)).toMatchObject({ port: bridge.port, token: bridge.token, projectPath: p.dir });
  });

  it("returns null for another project's bridge or an unreadable file", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir, { projectPath: "/somewhere/else" });
    expect(findBridge(p.dir)).toBeNull();
    fs.writeFileSync(path.join(p.dir, "Library", "DesignUi", "bridge.json"), "{ broken");
    expect(findBridge(p.dir)).toBeNull();
  });
});

describe("runUnity: editor route", () => {
  it("POSTs import to the bridge with the token and returns via editor", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const cfg = readConfig(p.dir);
    const r = await runUnity(cfg, "import", { exportDir: "/x/export", discardManualEdits: "false" }, fast);
    expect(r).toMatchObject({ code: 0, via: "editor" });
    expect(r.logTail).toContain("imported");
    const post = bridge.requests.find((q) => q.method === "POST");
    expect(post).toMatchObject({
      path: "/import", auth: `Bearer ${bridge.token}`,
      body: { profile: "Assets/DesignUi/DesignUiProfile.asset", exportDir: "/x/export", discardManualEdits: false },
    });
    expect(p.runnerCalls()).toEqual([]);
  });

  it("waits until the Editor has finished compiling after an import", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.compilingPolls = 3;
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.code).toBe(0);
    expect(bridge.compilingPolls).toBe(0);
    expect(bridge.requests.filter((q) => q.path === "/status").length).toBeGreaterThanOrEqual(4);
  });

  it("POSTs kit sync with the kit folder", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const cfg = readConfig(p.dir);
    await runUnity(cfg, "kitSync", {}, fast);
    expect(bridge.requests.find((q) => q.method === "POST")).toMatchObject({ path: "/kit-sync", body: { profile: cfg.profileAsset, kitDir: cfg.kitDir } });
  });

  it("passes a non-zero Unity code through (2 = not available yet)", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = { code: 2, log: "Not available yet: import arrives with the import pipeline." };
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r).toMatchObject({ code: 2, via: "editor" });
    expect(r.logTail).toContain("Not available yet");
  });

  it("fails without a bridge and names the project; the command runner is not called", async () => {
    const p = tempProject({ prefer: "editor" });
    const err = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast).catch((e) => e);
    expect(err).toBeInstanceOf(UnityRunnerError);
    expect(String(err.message)).toContain(`Unity Editor bridge not found for ${p.dir}`);
    expect(p.runnerCalls()).toEqual([]);
  });

  it("fails when the bridge rejects the token", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir, { tokenInFile: "b".repeat(64) });
    const err = await runUnity(readConfig(p.dir), "kitSync", {}, fast).catch((e) => e);
    expect(err).toBeInstanceOf(UnityRunnerError);
    expect(String(err.message)).toMatch(/401/);
  });

  it("never sends capture to the bridge", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const r = await runUnity(readConfig(p.dir), "capture", { exportDir: "/x/export", outDir: "/x/unity" }, fast);
    expect(r).toMatchObject({ code: 0, via: "command" });
    expect(bridge.requests).toEqual([]);
    expect(p.runnerCalls()).toEqual(["capture|/x/export|/x/unity| env=/x/export"]);
  });
});

describe("runUnity: command route", () => {
  it("runs the argv template with variables substituted", async () => {
    const p = tempProject({ prefer: "command" });
    const cfg = readConfig(p.dir);
    const r = await runUnity(cfg, "import", { exportDir: "/x/export" }, fast);
    expect(r).toMatchObject({ code: 0, via: "command" });
    expect(r.logTail).toContain("stub-runner: done");
    expect(p.runnerCalls()).toEqual([`import|${p.dir}|${cfg.profileAsset}|/x/export| env=/x/export`]);
  });

  it("returns the exit code of a failing command", async () => {
    const p = tempProject({ prefer: "command", exit: 3 });
    const r = await runUnity(readConfig(p.dir), "kitSync", {}, fast);
    expect(r.code).toBe(3);
  });

  it("names an empty template", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig({ unityRunner: { prefer: "command", command: { import: [] } } });
    const err = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast).catch((e) => e);
    expect(String(err.message)).toContain("unityRunner.command.import");
  });
});

describe("expandTemplate", () => {
  it("substitutes known placeholders inside arguments", () => {
    expect(expandTemplate(["unity", "--out={outDir}/a", "{kitDir}"], { outDir: "/o", kitDir: "/k" })).toEqual(["unity", "--out=/o/a", "/k"]);
  });
  it("rejects unknown or unset placeholders", () => {
    expect(() => expandTemplate(["{nope}"], {})).toThrow(/\{nope\}/);
    expect(() => expandTemplate(["{exportDir}"], {})).toThrow(/\{exportDir\}/);
  });
});

describe("bridgeStatus", () => {
  it("is connected with a live bridge and not-found without one", async () => {
    const p = tempProject({ prefer: "editor" });
    expect((await bridgeStatus(p.dir)).bridge).toBe("not-found");
    bridge = await startStubBridge(p.dir);
    expect(await bridgeStatus(p.dir)).toMatchObject({ bridge: "connected", port: bridge.port, isCompiling: false });
    await bridge.close();
    bridge = null;
    expect((await bridgeStatus(p.dir)).bridge).toBe("not-responding");
  });

  it("does not follow a redirect (the token never leaves for another address)", async () => {
    const p = tempProject({ prefer: "editor" });
    const hits: string[] = [];
    const target = http.createServer((req, res) => { hits.push(String(req.headers.authorization)); res.end("{}"); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as { port: number }).port;
    const redirect = http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${tport}/status` }); res.end(); });
    await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
    const rport = (redirect.address() as { port: number }).port;
    fs.mkdirSync(path.join(p.dir, "Library", "DesignUi"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, "Library", "DesignUi", "bridge.json"), JSON.stringify({ port: rport, token: "e".repeat(64), projectPath: p.dir }));
    try {
      expect((await bridgeStatus(p.dir)).bridge).not.toBe("connected");
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => target.close(r));
      await new Promise((r) => redirect.close(r));
    }
  });

  it("reports unauthorized for a token the bridge rejects", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir, { tokenInFile: "c".repeat(64) });
    expect((await bridgeStatus(p.dir)).bridge).toBe("unauthorized");
  });
});
