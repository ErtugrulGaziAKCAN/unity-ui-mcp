import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBridge, bridgeStatus, probeBridge } from "../src/bridge.js";
import { readConfig } from "../src/config.js";
import { CompileWaitTimeout, expandTemplate, runUnity, UnityRunnerError } from "../src/runner.js";
import { manualClock, startStubBridge, tempProject, type StubBridge } from "./helpers.js";

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

  const answer = (extra: Record<string, unknown>) => ({
    code: 0, log: "Imported a into Assets/UI/Generated/A: 2 files written (40 ms).", changed: ["/p/Assets/UI/Generated/A/A.uss"],
    imported: ["Assets/UI/Generated/A/A.uss"], compiled: [], compiling: false, compileId: null, ms: 40, ...extra,
  });

  it("returns as soon as the bridge answers when no script changed, with the bridge's fields", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({});
    bridge.compilingPolls = 5; // would be waited for by an older bridge's protocol
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r).toMatchObject({ code: 0, via: "editor" });
    expect(r.answer).toEqual({
      changed: ["/p/Assets/UI/Generated/A/A.uss"], imported: ["Assets/UI/Generated/A/A.uss"], compiled: [], compiling: false, compileId: null, ms: 40,
      scriptsFailed: null, // this answer does not say
      output: null, // nor where the screen was written
    });
    expect(r.compile).toBeUndefined();
    expect(bridge.requests.filter((q) => q.path === "/status")).toHaveLength(0);
    expect(r.timings.compileWait).toBeUndefined();
  });

  it("after a script change waits until /status stops compiling, across the reload, and reports how the compile ended", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({ compiled: ["Assets/UI/Generated/A/AView.g.cs"], compiling: true, compileId: 7 });
    bridge.compilingPolls = 2;
    bridge.downPolls = 2;
    bridge.lastCompile = { id: 7, state: "reloaded", ok: true, errors: [] };
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.code).toBe(0);
    expect(r.answer?.compiled).toEqual(["Assets/UI/Generated/A/AView.g.cs"]);
    expect(r.compile).toEqual({ id: 7, state: "reloaded", ok: true, errors: [] });
    expect(bridge.compilingPolls).toBe(0);
    expect(bridge.downPolls).toBe(0);
    expect(typeof r.timings.compileWait).toBe("number");
  });

  it("reports a compile that failed with its errors", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({ compiled: ["Assets/A/AView.g.cs"], compiling: true, compileId: 3 });
    bridge.compilingPolls = 1;
    bridge.lastCompile = { id: 3, state: "failed", ok: false, errors: ["Assets/A/AView.g.cs(3,1): error CS1002: ; expected"] };
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.code).toBe(0);
    expect(r.compile).toMatchObject({ state: "failed", ok: false });
    expect(r.compile?.errors[0]).toContain("CS1002");
  });

  it("names a compile result it cannot tie to its import as unknown, and not ok unless the scripts demonstrably compile", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({ compiled: ["Assets/A/AView.g.cs"], compiling: true, compileId: 4 });
    bridge.lastCompile = { id: 2, state: "reloaded", ok: true, errors: [] };
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.compile).toMatchObject({ id: 4, state: "unknown", ok: false });
    bridge.scriptsFailed = false;
    const known = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(known.compile).toMatchObject({ id: 4, state: "unknown", ok: true });
    expect(known.scriptsFailed).toBe(false);
  });

  it("takes a compile that already ended inside the import from the answer, without waiting", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({
      compiled: ["Assets/A/AView.g.cs"], compiling: false, compileId: 6, scriptsFailed: true,
      lastCompile: { id: 6, state: "failed", ok: false, errors: ["Assets/A/AView.g.cs(1,1): error CS0101: duplicate"] },
    });
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.compile).toMatchObject({ id: 6, state: "failed", ok: false, errors: ["Assets/A/AView.g.cs(1,1): error CS0101: duplicate"] });
    expect(r.scriptsFailed).toBe(true);
    expect(bridge.requests.filter((q) => q.path === "/status")).toHaveLength(0);
  });

  it("reports scripts that do not compile even when the import changed no script", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({ scriptsFailed: true, lastCompile: { id: 3, state: "failed", ok: false, errors: ["X.cs(2,2): error CS1002"] } });
    const r = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, fast);
    expect(r.compile).toBeUndefined();
    expect(r.scriptsFailed).toBe(true);
    expect(r.scriptErrors).toEqual(["X.cs(2,2): error CS1002"]);
  });

  it("stops waiting for the compile after the limit", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    bridge.answer = answer({ compiled: ["Assets/A/AView.g.cs"], compiling: true, compileId: 5 });
    bridge.compilingPolls = 1_000_000;
    const err = await runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, { ...fast, compileTimeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(CompileWaitTimeout);
    expect(err).toBeInstanceOf(UnityRunnerError);
    expect(String(err.message)).toMatch(/still compiling/);
    expect(err.answer.compileId).toBe(5);
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

  it("passes the import done marker's path as DESIGN_UI_IMPORT_DONE", async () => {
    const p = tempProject({ prefer: "command" });
    const exportDir = path.join(p.dir, "export");
    fs.mkdirSync(exportDir);
    fs.writeFileSync(path.join(exportDir, "screen.ir.json"), "{}");
    const done = path.join(p.dir, "import-done.json");
    const r = await runUnity(readConfig(p.dir), "import", { exportDir, importDone: done }, fast);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(done, "utf8"))).toEqual({
      imports: [{ exportDir, code: 0, irSha: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", output: "Assets/UI/Generated/CleanScreen" }],
    });
  });

  it("puts the server's own node first on the command's PATH and names it in DESIGN_UI_NODE (a client's minimal PATH)", async () => {
    const p = tempProject({ prefer: "command" });
    const cfg = readConfig(p.dir);
    const seen = path.join(p.dir, "env.txt");
    cfg.unityRunner.command.capture = ["sh", "-c", 'printf "%s\\n%s\\n%s\\n" "$PATH" "$DESIGN_UI_NODE" "$(command -v node)" > "$0"', seen];
    // a GUI client that starts the server with the system PATH only (no node on it)
    const before = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      expect((await runUnity(cfg, "capture", { exportDir: "/x", outDir: "/y" }, fast)).code).toBe(0);
    } finally { process.env.PATH = before; }
    const [pathSeen, nodeSeen, found] = fs.readFileSync(seen, "utf8").split("\n");
    expect(pathSeen.split(path.delimiter)).toEqual([path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(nodeSeen).toBe(process.execPath);
    expect(found).toBe(path.join(path.dirname(process.execPath), "node"));
  });

  it("returns the exit code of a failing command", async () => {
    const p = tempProject({ prefer: "command", exit: 3 });
    const r = await runUnity(readConfig(p.dir), "kitSync", {}, fast);
    expect(r.code).toBe(3);
  });

  it("ends a command that ignores SIGTERM with SIGKILL after the grace, and leaves no timer or progress behind", async () => {
    const p = tempProject({ prefer: "command" });
    p.writeConfig({ unityRunner: { prefer: "command", timeoutSec: 1, command: { import: ["sh", "-c", "trap '' TERM; echo started; exec sleep 30"], capture: [], kitSync: [] } } });
    const clock = manualClock();
    const progress: string[] = [];
    const run = runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, { ...fast, clock, onProgress: (l) => progress.push(l), progressEveryMs: 100 });
    const failed = expect(run).rejects.toThrow(/did not finish within 1 s/);
    await new Promise((r) => setTimeout(r, 200)); // the command starts and ignores SIGTERM
    clock.advance(1000);
    clock.advance(2000); // the grace runs on the same clock
    await failed;
    expect(clock.pending()).toBe(0);
    const seen = progress.length;
    clock.advance(30_000);
    expect(progress.length).toBe(seen);
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

describe("runUnity: long Editor operations", () => {
  it("waits for a bridge answer as long as unityRunner.timeoutSec allows, past Node's hidden 300 s fetch limits, and reports progress meanwhile", async () => {
    const p = tempProject({ prefer: "editor" });
    p.writeConfig({ unityRunner: { prefer: "editor", timeoutSec: 1800 } });
    bridge = await startStubBridge(p.dir);
    const hold = bridge.holdPosts();
    const clock = manualClock();
    const progress: string[] = [];
    const run = runUnity(readConfig(p.dir), "kitSync", {}, { ...fast, clock, progressEveryMs: 10_000, onProgress: (m) => progress.push(m) });
    await hold.arrived;
    clock.advance(301_000); // simulated: past undici's 300 s headers timeout, which fetch would apply
    hold.release();
    const r = await run;
    expect(r).toMatchObject({ code: 0, via: "editor" });
    expect(progress).toHaveLength(30);
    expect(progress[0]).toMatch(/kit sync.*10 s/i);
    expect(progress[29]).toMatch(/300 s/);
    expect(clock.pending()).toBe(0); // the request's own timer and progress timer are gone with it
  });

  it("stops a bridge request at the configured timeout and names it", async () => {
    const p = tempProject({ prefer: "editor" });
    p.writeConfig({ unityRunner: { prefer: "editor", timeoutSec: 400 } });
    bridge = await startStubBridge(p.dir);
    const hold = bridge.holdPosts();
    const clock = manualClock();
    const run = runUnity(readConfig(p.dir), "import", { exportDir: "/x" }, { ...fast, clock });
    const failed = expect(run).rejects.toThrow(/did not answer POST \/import within 400 s \(unityRunner\.timeoutSec in /);
    await hold.arrived;
    clock.advance(399_000);
    clock.advance(1_001);
    await failed;
    await expect(run).rejects.toBeInstanceOf(UnityRunnerError);
    hold.release();
  });

  it("never sends a bridge request through fetch", async () => {
    const p = tempProject({ prefer: "editor" });
    bridge = await startStubBridge(p.dir);
    const real = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { fetched++; return real(...a); }) as typeof fetch;
    try {
      await runUnity(readConfig(p.dir), "kitSync", {}, fast);
      await bridgeStatus(p.dir);
    } finally { globalThis.fetch = real; }
    expect(fetched).toBe(0);
  });
});

describe("probeBridge", () => {
  it("caches one answer per bridge.json for a few seconds; a new bridge.json is probed again", async () => {
    const p = tempProject({ prefer: "editor" });
    expect((await probeBridge(p.dir)).bridge).toBe("not-found");
    bridge = await startStubBridge(p.dir);
    expect((await probeBridge(p.dir)).bridge).toBe("connected");
    expect((await probeBridge(p.dir)).bridge).toBe("connected");
    expect(bridge.requests.filter((q) => q.path === "/status")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    expect((await probeBridge(p.dir, { maxAgeMs: 50 })).bridge).toBe("connected");
    expect(bridge.requests.filter((q) => q.path === "/status")).toHaveLength(2);
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
