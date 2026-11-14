import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/capture-on-copy.sh");

/** The open Editor's per-process and lock files of a project (relative paths): none may reach a copy Unity starts on. */
const PROCESS_FILES = [
  "Library/ilpp.pid", "Library/EditorInstance.json", "Library/ArtifactDB-lock", "Library/SourceAssetDB-lock",
  "Library/Bee/backend.pid", "Library/Search/assets.index-lock", "Temp/UnityLockfile", "UnityLockfile",
  "Library/com.example.tool/Temp/.lock", "Library/com.example.tool/server.lock",
];
/** Files of the same project a copy keeps (the Library's caches, a package's own lock file). */
const KEPT_FILES = ["Library/ScriptAssemblies/Game.dll", "Library/ArtifactDB", "Library/PackageCache/com.example.x/yarn.lock", "Assets/Scene.unity"];

/**
 * A Unity project with a relative file: package, the open Editor's process files and a stub Unity that records what it
 * saw in the copy (when it ran, its pid, and which earlier stub Unity runs were still alive when it started), waits while
 * `<root>/hold` exists, then exits `code`.
 */
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function setup(code: number) {
  const root = tempDir("design-ui-capture-test-");
  roots.push(root);
  const project = path.join(root, "Game"), out = path.join(root, "out"), seen = path.join(root, "seen.json");
  for (const f of [...PROCESS_FILES, ...KEPT_FILES]) {
    fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
    fs.writeFileSync(path.join(project, f), f);
  }
  fs.mkdirSync(path.join(project, "Packages"), { recursive: true });
  fs.mkdirSync(path.join(root, "local-pkg"), { recursive: true });
  const manifest = `{\n  "dependencies": {\n    "com.example.local": "file:../../local-pkg",\n    "com.unity.ugui": "2.0.0"\n  }\n}\n`;
  fs.writeFileSync(path.join(project, "Packages", "manifest.json"), manifest);
  const unity = path.join(root, "Unity");
  fs.writeFileSync(unity, `#!/bin/sh
p=""; while [ $# -gt 0 ]; do [ "$1" = -projectPath ] && p="$2"; shift; done
alive=""
for q in $(cat "${root}/unity.pids" 2>/dev/null); do kill -0 "$q" 2>/dev/null && alive="$alive $q"; done
echo $$ >> "${root}/unity.pids"
node -e '
const fs = require("fs"), path = require("path"), p = process.argv[1];
const files = (d, rel = "") => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name), rel + e.name + "/") : [rel + e.name]); } catch { return []; } };
fs.appendFileSync(process.argv[2], JSON.stringify({ copy: p, manifest: JSON.parse(fs.readFileSync(p + "/Packages/manifest.json", "utf8")), files: files(p), start: Date.now(), pid: Number(process.argv[3]), alive: process.argv[4].trim().split(" ").filter(Boolean) }) + "\\n");
' "$p" "${seen}" "$$" "$alive"
while [ -e "${root}/hold" ]; do sleep 0.05; done
echo "{\\"end\\": $(node -p 'Date.now()')}" >> "${seen}"
mkdir -p "$DESIGN_UI_OUT_DIR" && echo '{}' > "$DESIGN_UI_OUT_DIR/capture-done.json"
exit ${code}
`);
  fs.chmodSync(unity, 0o755);
  const lockDir = path.join(root, "slots");
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env, DESIGN_UI_OUT_DIR: out, CAPTURE_COPY_LOCK_DIR: lockDir, CAPTURE_COPY_POLL_SEC: "0.1", CAPTURE_COPY_MIN_FREE_GB: "0", ...extra,
  });
  const runs = () => fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { root, project, out, seen, unity, manifest, lockDir, env, runs };
}

const modes = process.platform === "darwin" ? ["clone", "rsync"] : ["rsync"];

type Setup = ReturnType<typeof setup>;
/** The script started in the background (its pid, output so far, exit). */
function start(s: Setup, extra: string[] = [], env: Record<string, string> = {}) {
  const child = spawn("bash", [SCRIPT, s.project, s.unity, ...extra], { env: s.env(env) });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  // the process itself (an orphaned Unity can keep its output pipes open after it is gone)
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, done, exited, out: () => out };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 20000) {
  const t0 = Date.now();
  while (!what()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(50); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const slots = (s: Setup) => (fs.existsSync(s.lockDir) ? fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot.")) : []);

describe("scripts/capture-on-copy.sh", () => {
  for (const code of [0, 3]) {
    it(`captures on a temporary copy that lists the package's tests, and removes the copy afterwards (Unity exit ${code})`, () => {
      const s = setup(code);
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env(), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(code);
      const [seen] = s.runs();
      // the copy: elsewhere, with the project's files, without Temp, listing the tests, with absolute file: packages
      expect(seen.copy).not.toBe(s.project);
      expect(seen.files).toContain("Assets/Scene.unity");
      expect(seen.files.some((f: string) => f.startsWith("Temp/"))).toBe(false);
      expect(seen.manifest.testables).toEqual(["com.ertugrulgaziakcan.design-ui"]);
      expect(seen.manifest.dependencies["com.example.local"]).toBe(`file:${path.join(s.root, "local-pkg")}`);
      // removed, success or failure; the output stays where the server asked; the project is untouched; the slot is free
      expect(fs.existsSync(seen.copy)).toBe(false);
      expect(fs.existsSync(path.join(s.out, "capture-done.json"))).toBe(true);
      expect(fs.readFileSync(path.join(s.project, "Packages", "manifest.json"), "utf8")).toBe(s.manifest);
      for (const f of [...PROCESS_FILES, ...KEPT_FILES]) expect(fs.existsSync(path.join(s.project, f)), f).toBe(true);
      expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
    });
  }

  for (const mode of modes) {
    it(`deletes the open Editor's process and lock files from the copy before Unity starts (${mode})`, () => {
      const s = setup(0);
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env({ CAPTURE_COPY_MODE: mode }), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const [seen] = s.runs();
      for (const f of PROCESS_FILES) expect(seen.files, `${f} reached the copy`).not.toContain(f);
      for (const f of KEPT_FILES) expect(seen.files, `${f} is missing in the copy`).toContain(f);
    });
  }

  it("runs one capture at a time by default: a second one waits for the first one's slot, --slots 2 runs both", async () => {
    const s = setup(0);
    fs.writeFileSync(path.join(s.root, "hold"), "");
    const first = start(s);
    await until(() => s.runs().length === 1);
    const second = start(s);
    await until(() => second.out().includes("waiting for a capture slot (1 of 1 in use"));
    await new Promise((r) => setTimeout(r, 400));
    expect(s.runs().length, "the second capture's Unity has not started").toBe(1);
    fs.rmSync(path.join(s.root, "hold"));
    expect((await first.done).code).toBe(0);
    expect((await second.done).code).toBe(0);
    const [a, aEnd, b] = s.runs();
    expect(b.start).toBeGreaterThanOrEqual(aEnd.end);
    expect(a.copy).not.toBe(b.copy);

    // two slots: both Unity runs overlap
    fs.rmSync(s.seen);
    fs.writeFileSync(path.join(s.root, "hold"), "");
    const c = start(s, ["--slots", "2"]), d = start(s, ["--slots", "2"]);
    await until(() => s.runs().length === 2);
    fs.rmSync(path.join(s.root, "hold"));
    expect([(await c.done).code, (await d.done).code]).toEqual([0, 0]);
    expect(c.out() + d.out()).not.toContain("waiting");
  }, 60000);

  it("stopped by the MCP server's timeout (SIGTERM, then SIGKILL), it stops its Unity first: the slot frees, the copy goes, nothing overlaps", async () => {
    const s = setup(0);
    fs.writeFileSync(path.join(s.root, "hold"), ""); // a hung capture
    const first = start(s);
    await until(() => s.runs().length === 1);
    const second = start(s);
    await until(() => second.out().includes("waiting for a capture slot"));
    const [hung] = s.runs();
    // the server: SIGTERM, a two-second grace, SIGKILL
    first.child.kill("SIGTERM");
    const killer = setTimeout(() => first.child.kill("SIGKILL"), 2000);
    const exit = await first.done;
    clearTimeout(killer);
    expect(exit.code ?? exit.signal).toBe(143);
    expect(alive(hung.pid), "the stub Unity is stopped").toBe(false);
    await until(() => !fs.existsSync(hung.copy), 10000); // removed in the background
    // the waiting capture takes the slot, and its Unity starts with no earlier one alive
    await until(() => s.runs().length === 2);
    const next = s.runs().filter((r) => r.copy)[1];
    expect(next.alive, "no earlier stub Unity was alive when the next one started").toEqual([]);
    fs.rmSync(path.join(s.root, "hold"));
    expect((await second.done).code).toBe(0);
    expect(slots(s)).toEqual([]);
  }, 60000);

  for (const sig of ["SIGINT", "SIGHUP"] as const) {
    it(`a ${sig} stops its Unity, frees the slot and removes the copy`, async () => {
      const s = setup(0);
      fs.writeFileSync(path.join(s.root, "hold"), "");
      const run = start(s);
      await until(() => s.runs().length === 1);
      const [unity] = s.runs();
      run.child.kill(sig);
      await run.done;
      expect(alive(unity.pid)).toBe(false);
      expect(slots(s)).toEqual([]);
      await until(() => !fs.existsSync(unity.copy), 10000);
    }, 30000);
  }

  it("a slot whose script was SIGKILLed counts while its Unity still runs on its copy", async () => {
    const s = setup(0);
    fs.writeFileSync(path.join(s.root, "hold"), "");
    const first = start(s);
    await until(() => s.runs().length === 1);
    first.child.kill("SIGKILL"); // no trap runs: the stub Unity is left running in the copy
    await first.exited;
    const second = start(s);
    await until(() => second.out().includes("waiting for a capture slot (1 of 1 in use"));
    await sleep(400);
    expect(s.runs().length, "the second Unity waits for the orphaned one").toBe(1);
    fs.rmSync(path.join(s.root, "hold"));
    expect((await second.done).code).toBe(0);
    const [orphan, , next] = s.runs();
    expect(next.alive).toEqual([]);
    fs.rmSync(orphan.copy, { recursive: true, force: true }); // the killed script could not remove it
  }, 60000);

  it("takes over a slot whose holder is gone (killed, or its pid reused by another program)", () => {
    const s = setup(0);
    fs.mkdirSync(s.lockDir, { recursive: true });
    const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(s.lockDir, `slot.${dead}`), dead);
    fs.writeFileSync(path.join(s.lockDir, `slot.${process.pid}`), String(process.pid)); // alive, but not a capture
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("waiting");
    expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
  });

  it("never waits for itself: a stale slot file that carries the new run's own pid does not count", () => {
    const s = setup(0);
    fs.mkdirSync(s.lockDir, { recursive: true });
    // the same pid: sh writes the slot file, then becomes the capture (exec keeps the pid)
    const r = spawnSync("sh", ["-c", `echo $$ > "${s.lockDir}/slot.$$" && exec bash "${SCRIPT}" "${s.project}" "${s.unity}"`], { env: s.env(), encoding: "utf8", timeout: 20000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("waiting");
    expect(slots(s)).toEqual([]);
  });

  it("takes over a slot mutex whose owner is gone at once", () => {
    const s = setup(0);
    fs.mkdirSync(path.join(s.lockDir, ".mutex"), { recursive: true });
    const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(s.lockDir, ".mutex", "owner"), dead);
    const t0 = Date.now();
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(fs.existsSync(path.join(s.lockDir, ".mutex"))).toBe(false);
  });

  it("rsync: an unreadable folder and files that vanish under du or rsync are reported, and the capture goes on", () => {
    const s = setup(0);
    const locked = path.join(s.project, "Library", "Locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "data"), "x");
    fs.chmodSync(locked, 0o000);
    try {
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env({ CAPTURE_COPY_MODE: "rsync" }), encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/du could not read all of .* \(\d+ error\(s\), first: .*Locked.*\); the size it read, \d+ GB, is the estimate/);
      expect(r.stdout).toMatch(/rsync could not copy every file of .* \(exit 23: unreadable or vanished files, listed above\); capturing on the rest/);
      expect(s.runs().filter((x) => x.copy)).toHaveLength(1);
    } finally { fs.chmodSync(locked, 0o755); }

    // a du that loses a file while it walks (an open Editor deletes files under it): a non-zero exit, a partial total
    const bin = path.join(s.root, "du-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "du"), `#!/bin/sh\necho "du: Library/Temp/x.tmp: No such file or directory" >&2\nprintf '1234\\t%s\\n' "$2"\nexit 1\n`, { mode: 0o755 });
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env({ CAPTURE_COPY_MODE: "rsync", PATH: `${bin}:${process.env.PATH}` }), encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("du could not read all of");
    expect(r.stdout).toContain("x.tmp: No such file or directory");
    expect(s.runs().filter((x) => x.copy)).toHaveLength(2);
  });

  it("says so when it cannot read the free disk space", () => {
    const s = setup(0);
    const bin = path.join(s.root, "df-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "df"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env({ PATH: `${bin}:${process.env.PATH}` }), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could not read the free space of the disk of");
    expect(s.runs()).toEqual([]);
  });

  it("stops before copying when the disk has less free space than --min-free-gb, and says so", () => {
    const s = setup(0);
    const tmp = path.join(s.root, "tmp");
    fs.mkdirSync(tmp);
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity, "--min-free-gb", "999999"], { env: s.env({ TMPDIR: tmp }), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/capture-on-copy: only \d+ GB free on the disk of .*; the capture copy needs .*999999 GB \(--min-free-gb\)\. .*Nothing was copied\./);
    expect(s.runs()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
  });

  it("rejects a slot count that is not a positive whole number", () => {
    const s = setup(0);
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity, "--slots", "0"], { env: s.env(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--slots must be a whole number of at least 1");
  });
});
